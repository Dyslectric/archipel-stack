//! Federation transport. DNS is checked on every request, including requests
//! using an existing connection. Pools are pinned to the validated address.
use crate::{Config, Failure};
use axum::http::{HeaderMap, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Method, Url};
use rsa::{
    RsaPublicKey, pkcs1::EncodeRsaPublicKey, pkcs8::DecodePublicKey, traits::PublicKeyParts,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    time::{Duration, SystemTime},
};
use tokio::sync::Mutex;

pub fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}
pub fn public_address(address: IpAddr) -> bool {
    let address = match address {
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
        _ => address,
    };
    // Same ranges as ipaddr.js process(address).range() === "unicast".
    let ranges: &[&str] = match address {
        IpAddr::V4(_) => &[
            "0.0.0.0/8",
            "255.255.255.255/32",
            "224.0.0.0/4",
            "169.254.0.0/16",
            "127.0.0.0/8",
            "100.64.0.0/10",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.88.99.0/24",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "240.0.0.0/4",
            "192.175.48.0/24",
            "192.31.196.0/24",
            "192.52.193.0/24",
        ],
        IpAddr::V6(_) => &[
            "::/128",
            "fe80::/10",
            "ff00::/8",
            "::1/128",
            "fc00::/7",
            "100::/64",
            "::ffff:0:0:0/96",
            "64:ff9b::/96",
            "2002::/16",
            "2001::/32",
            "2001:2::/48",
            "2001:3::/32",
            "2001:4:112::/48",
            "2620:4f:8000::/48",
            "2001:10::/28",
            "2001:20::/28",
            "2001:30::/28",
            "2001::/23",
            "2001:db8::/32",
        ],
    };
    !ranges.iter().any(|range| {
        range
            .parse::<ipnet::IpNet>()
            .expect("constant CIDR")
            .contains(&address)
    })
}
pub fn peer_url(value: &str, config: &Config) -> Result<Url, Failure> {
    if value.encode_utf16().count() > 2048 {
        return Err(Failure(StatusCode::BAD_REQUEST, "Invalid federation URL."));
    }
    let url = Url::parse(value).map_err(|_| {
        Failure(
            StatusCode::BAD_REQUEST,
            "Use an absolute HTTPS actor or instance URL.",
        )
    })?;
    let host = url.host_str().unwrap_or("");
    let local = config.dev_auth
        && loopback(&config.policy_host)
        && Url::parse(&config.base)
            .ok()
            .and_then(|u| u.host_str().map(loopback))
            == Some(true)
        && loopback(host);
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https" && !(local && url.scheme() == "http"))
    {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Federation requires HTTPS; loopback HTTP is allowed only in local development.",
        ));
    }
    if host
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|ip| !public_address(ip))
        && !local
    {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Private network federation targets are prohibited.",
        ));
    }
    Ok(url)
}
pub fn digest(body: &[u8]) -> String {
    format!("SHA-256={}", STANDARD.encode(Sha256::digest(body)))
}
type Pools = (HashMap<String, Client>, VecDeque<String>);
#[derive(Default)]
pub struct Transport {
    pools: Mutex<Pools>,
}
pub struct PeerResponse {
    pub body: Vec<u8>,
    pub headers: HeaderMap,
}
impl Transport {
    #[allow(clippy::too_many_arguments)] // Mirrors the bounded wire operation.
    pub async fn request(
        &self,
        config: &Config,
        url: &Url,
        method: Method,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        max_bytes: usize,
        timeout: Duration,
    ) -> Result<PeerResponse, Failure> {
        let url = peer_url(url.as_str(), config)?;
        tokio::time::timeout(timeout, async {
            let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
            let port = url
                .port_or_known_default()
                .ok_or(Failure(StatusCode::BAD_REQUEST, "Invalid federation URL."))?;
            let addresses: Vec<_> = if let Ok(ip) = host.parse::<IpAddr>() {
                vec![SocketAddr::new(ip, port)]
            } else {
                tokio::net::lookup_host((host, port))
                    .await
                    .map_err(|_| network_error())?
                    .collect()
            };
            if addresses.is_empty()
                || addresses.iter().any(|a| {
                    !public_address(a.ip())
                        && !(config.dev_auth && loopback(host) && loopback(&a.ip().to_string()))
                })
            {
                return Err(Failure(
                    StatusCode::BAD_REQUEST,
                    "Federation DNS resolved to a private or reserved address.",
                ));
            }
            let address = addresses[0];
            let kind = if body.is_some() {
                "post"
            } else if headers.contains_key("signature") {
                "signed-read"
            } else {
                "discovery"
            };
            let key = format!("{}|{address}|{kind}", url.origin().ascii_serialization());
            let client = {
                let mut pools = self.pools.lock().await;
                if let Some(client) = pools.0.get(&key).cloned() {
                    pools.1.retain(|k| k != &key);
                    pools.1.push_back(key);
                    client
                } else {
                    let client = Client::builder()
                        .no_proxy()
                        .redirect(reqwest::redirect::Policy::none())
                        .resolve(host, address)
                        .pool_max_idle_per_host(4)
                        .pool_idle_timeout(Duration::from_secs(5))
                        .connect_timeout(Duration::from_secs(5))
                        .build()
                        .map_err(|_| network_error())?;
                    if pools.0.len() >= 64
                        && let Some(old) = pools.1.pop_front()
                    {
                        pools.0.remove(&old);
                    }
                    pools.0.insert(key.clone(), client.clone());
                    pools.1.push_back(key);
                    client
                }
            };
            let mut request = client.request(method, url).headers(headers);
            if let Some(body) = body {
                request = request.body(body);
            }
            let mut response = request.send().await.map_err(|_| network_error())?;
            let status = response.status();
            if !status.is_success() {
                return Err(Failure(
                    status,
                    "Peer returned an unsuccessful HTTP status.",
                ));
            }
            let headers = response.headers().clone();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
                if body.len().saturating_add(chunk.len()) > max_bytes {
                    return Err(Failure(
                        StatusCode::BAD_GATEWAY,
                        "Peer response exceeds the size limit.",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(PeerResponse { body, headers })
        })
        .await
        .map_err(|_| network_error())?
    }
    pub async fn json(&self, config: &Config, url: &Url) -> Result<serde_json::Value, Failure> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "accept",
            "application/activity+json, application/json"
                .parse()
                .expect("header"),
        );
        let response = self
            .request(
                config,
                url,
                Method::GET,
                headers,
                None,
                262144,
                Duration::from_secs(15),
            )
            .await?;
        let content_type = response
            .headers
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            content_type.as_str(),
            "application/activity+json"
                | "application/ld+json"
                | "application/jrd+json"
                | "application/json"
        ) {
            return Err(Failure(
                StatusCode::BAD_GATEWAY,
                "Peer did not return ActivityStreams JSON.",
            ));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "Peer returned invalid JSON."))
    }
}
fn network_error() -> Failure {
    Failure(StatusCode::BAD_GATEWAY, "Network delivery failed.")
}

pub fn public_key(pem: &str) -> Result<RsaPublicKey, Failure> {
    let key = RsaPublicKey::from_public_key_pem(pem)
        .map_err(|_| Failure(StatusCode::UNAUTHORIZED, "Invalid actor signing key."))?;
    if key.n().bits() < 2048 || key.n().bits() > 8192 {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Actor must use an RSA signing key of at least 2048 bits.",
        ));
    }
    Ok(key)
}
pub fn verify_signature(pem: &str, bytes: &[u8], signature: &str) -> Result<(), Failure> {
    let key = public_key(pem)?
        .to_pkcs1_der()
        .map_err(|_| network_error())?;
    let signature = STANDARD
        .decode(signature)
        .map_err(|_| Failure(StatusCode::UNAUTHORIZED, "Invalid signature encoding."))?;
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        key.as_bytes(),
    )
    .verify(bytes, &signature)
    .map_err(|_| {
        Failure(
            StatusCode::UNAUTHORIZED,
            "Federation signature verification failed.",
        )
    })
}
pub fn signature_key(headers: &HeaderMap) -> Result<HashMap<String, String>, Failure> {
    let raw = headers
        .get("signature")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= 8000)
        .ok_or(Failure(
            StatusCode::UNAUTHORIZED,
            "A signed federation request is required.",
        ))?;
    let mut values = HashMap::new();
    for part in raw.split(',') {
        let (key, value) = part
            .trim()
            .split_once('=')
            .ok_or(Failure(StatusCode::UNAUTHORIZED, "Invalid HTTP signature."))?;
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_alphabetic())
            || value.len() < 3
            || !value.starts_with('"')
            || !value.ends_with('"')
            || value[1..value.len() - 1].contains(['"', '\r', '\n'])
            || values
                .insert(key.to_owned(), value[1..value.len() - 1].to_owned())
                .is_some()
        {
            return Err(Failure(StatusCode::UNAUTHORIZED, "Invalid HTTP signature."));
        }
    }
    if values.get("algorithm").map(String::as_str) != Some("rsa-sha256")
        || !values
            .get("keyId")
            .is_some_and(|s| s.ends_with("#main-key"))
    {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Unsupported HTTP signature.",
        ));
    }
    Ok(values)
}
pub fn verify_request(
    headers: &HeaderMap,
    method: &str,
    target: &str,
    actor: &serde_json::Value,
    body: Option<&[u8]>,
) -> Result<(), Failure> {
    let values = signature_key(headers)?;
    if actor["publicKey"]["id"].as_str() != values.get("keyId").map(String::as_str)
        || actor["publicKey"]["owner"] != actor["id"]
    {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Signing key does not belong to the actor.",
        ));
    }
    let date = headers
        .get("date")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| httpdate::parse_http_date(s).ok())
        .ok_or(Failure(
            StatusCode::UNAUTHORIZED,
            "Federation signature date expired.",
        ))?;
    let delta = SystemTime::now()
        .duration_since(date)
        .unwrap_or_else(|e| e.duration());
    if delta > Duration::from_secs(300) {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Federation signature date expired.",
        ));
    }
    let names: Vec<_> = values
        .get("headers")
        .map(String::as_str)
        .unwrap_or("")
        .split(' ')
        .collect();
    let mut required = vec!["(request-target)", "host", "date"];
    if body.is_some() {
        required.push("digest");
    }
    if !required.iter().all(|n| names.contains(n))
        || names
            .iter()
            .enumerate()
            .any(|(i, n)| names[..i].contains(n))
    {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "HTTP signature omits required headers.",
        ));
    }
    if let Some(body) = body
        && headers.get("digest").and_then(|s| s.to_str().ok()) != Some(digest(body).as_str())
    {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Federation body digest mismatch.",
        ));
    }
    let mut lines = Vec::new();
    for name in names {
        let value = if name == "(request-target)" {
            format!("{} {target}", method.to_ascii_lowercase())
        } else {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .ok_or(Failure(StatusCode::UNAUTHORIZED, "Invalid signed header."))?
                .to_owned()
        };
        if value.contains(['\r', '\n']) {
            return Err(Failure(StatusCode::UNAUTHORIZED, "Invalid signed header."));
        }
        lines.push(format!("{name}: {value}"));
    }
    verify_signature(
        actor["publicKey"]["publicKeyPem"].as_str().unwrap_or(""),
        lines.join("\n").as_bytes(),
        values.get("signature").map(String::as_str).unwrap_or(""),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            database: String::new(),
            schema: None,
            secret: "n".repeat(43),
            base: "http://127.0.0.1:8799".into(),
            host: "127.0.0.1".into(),
            port: 0,
            workers: 1,
            connections: 2,
            channel_concurrency: 1,
            dev_auth: true,
            policy_host: "127.0.0.1".into(),
            send_batch: 20,
            send_concurrency: 4,
            peer_rate: 0,
        }
    }
    #[test]
    fn peer_ranges_and_exact_development_exception() {
        for address in [
            "0.1.2.3",
            "127.0.0.2",
            "10.1.2.3",
            "100.64.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
            "192.0.2.1",
            "198.18.1.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "192.52.193.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "100::1",
            "64:ff9b::808:808",
            "2002:0808:0808::1",
            "2001:db8::1",
            "2001:20::1",
        ] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        for address in [
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "192.0.3.1",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(public_address(address.parse().unwrap()), "{address}");
        }
        let mut config = config();
        assert!(peer_url("http://127.0.0.1/test", &config).is_ok());
        assert!(peer_url("http://[::1]/test", &config).is_ok());
        for value in [
            "http://127.0.0.2/test",
            "https://10.1.2.3/test",
            "https://u:p@example.org/test",
            "https://example.org/#fragment",
        ] {
            assert!(peer_url(value, &config).is_err(), "{value}");
        }
        config.dev_auth = false;
        assert!(peer_url("https://127.0.0.1/", &config).is_err());
        assert!(peer_url("https://8.8.8.8/test", &config).is_ok());
        config.dev_auth = true;
        config.policy_host = "0.0.0.0".into();
        assert!(peer_url("http://127.0.0.1/", &config).is_err());
    }
    #[tokio::test]
    async fn transport_rejects_redirects_oversize_and_non_json_peers() {
        use axum::{Router, response::IntoResponse, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new()
            .route("/large", get(|| async { "x".repeat(1024) }))
            .route(
                "/redirect",
                get(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [("location", "http://127.0.0.2/")],
                    )
                        .into_response()
                }),
            )
            .route("/html", get(|| async { "<html>" }))
            .route("/json", get(|| async { axum::Json(json_value()) }));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let transport = Transport::default();
        let config = config();
        let url = |path| Url::parse(&format!("http://127.0.0.1:{port}/{path}")).unwrap();
        let response = transport
            .request(
                &config,
                &url("large"),
                Method::GET,
                HeaderMap::new(),
                None,
                100,
                Duration::from_secs(3),
            )
            .await;
        assert!(matches!(response, Err(Failure(StatusCode::BAD_GATEWAY, _))));
        let response = transport
            .request(
                &config,
                &url("redirect"),
                Method::GET,
                HeaderMap::new(),
                None,
                100,
                Duration::from_secs(3),
            )
            .await;
        assert!(matches!(
            response,
            Err(Failure(StatusCode::TEMPORARY_REDIRECT, _))
        ));
        assert!(transport.json(&config, &url("html")).await.is_err());
        assert_eq!(
            transport.json(&config, &url("json")).await.ok(),
            Some(json_value())
        );
        task.abort();
    }
    fn json_value() -> serde_json::Value {
        serde_json::json!({"type":"Person"})
    }
}
