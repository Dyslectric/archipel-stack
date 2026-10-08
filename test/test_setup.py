import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import setup


ROOT = Path(__file__).resolve().parent.parent
PROXY = {
    "BASE_URL": "https://chat.example.org",
    "TRUSTED_PROXY": "172.20.0.2",
    "PROXY_NETWORK": "edge",
    "OIDC_ISSUER": "https://identity.example.org",
    "OIDC_CLIENT_ID": "archipel",
    "OIDC_AUTH_METHOD": "none",
}


def defaults(_label, value, secret=False):
    return value


class SetupTests(unittest.TestCase):
    def test_xmpp_ports_are_prompted_validated_and_preserved_on_reconfiguration(self):
        prompts = []
        def custom_ports(label, value, secret=False):
            prompts.append(label)
            return {"XMPP client STARTTLS port": "55222", "XMPP federation port": "55269"}.get(label, value)
        settings = setup.collect_setup({"XMPP_DOMAIN": "chat.example.org"}, custom_ports)
        self.assertIn("XMPP client STARTTLS port", prompts)
        self.assertEqual(settings["XMPP_CLIENT_PORT"], "55222")
        self.assertEqual(settings["XMPP_SERVER_PORT"], "55269")
        with tempfile.TemporaryDirectory() as directory:
            setup.write_setup(directory, settings)
            public = setup.parse_env((Path(directory) / ".env").read_text())
            raw = setup.parse_raw_env((Path(directory) / ".env.container").read_text())
            restored = setup.collect_setup({**public, "XMPP_BRIDGE_SECRET": raw["XMPP_BRIDGE_SECRET"]}, defaults)
            self.assertEqual(restored["XMPP_CLIENT_PORT"], "55222")
            self.assertEqual(restored["XMPP_SERVER_PORT"], "55269")
        default = setup.collect_setup({"XMPP_DOMAIN": "chat.example.org"}, defaults)
        self.assertEqual(default["XMPP_CLIENT_PORT"], "5222")
        self.assertEqual(default["XMPP_SERVER_PORT"], "5269")
        for key in ("XMPP_CLIENT_PORT", "XMPP_SERVER_PORT"):
            for value in ("0", "65536", "-1", "5222.5", "5e3", "0x1466", "invalid"):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", key: value}, defaults)
        with self.assertRaisesRegex(ValueError, "ports must differ"):
            setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_CLIENT_PORT": "5269"}, defaults)

    def test_xmpp_setup_selects_prosody_and_keeps_bridge_secret_private_and_stable(self):
        settings = setup.collect_setup({"XMPP_DOMAIN": "chat.example.org"}, defaults)
        self.assertIn("compose.xmpp.yaml", settings["COMPOSE_FILE"])
        self.assertGreaterEqual(len(settings["XMPP_BRIDGE_SECRET"]), 43)
        with tempfile.TemporaryDirectory() as directory:
            setup.write_setup(directory, settings)
            raw = setup.parse_raw_env((Path(directory) / ".env.container").read_text())
            public = setup.parse_env((Path(directory) / ".env").read_text())
            self.assertEqual(public["XMPP_BRIDGE_SECRET"], "")
            self.assertEqual(raw["XMPP_BRIDGE_SECRET"], settings["XMPP_BRIDGE_SECRET"])
            restored = setup.collect_setup({**public, "XMPP_BRIDGE_SECRET": raw["XMPP_BRIDGE_SECRET"]}, defaults)
            self.assertEqual(restored["XMPP_BRIDGE_SECRET"], settings["XMPP_BRIDGE_SECRET"])
        for domain in ("chat..example", "-chat.example", "chat.example:5222", "Chat.Example"):
            with self.subTest(domain=domain), self.assertRaisesRegex(ValueError, "XMPP_DOMAIN"):
                setup.collect_setup({"XMPP_DOMAIN": domain}, defaults)

    def test_xmpp_ports_skip_ones_another_instance_holds_unless_already_chosen(self):
        busy = {5222, 5223, 5269}.__contains__
        second = setup.collect_setup({"XMPP_DOMAIN": "two.example.org"}, defaults, in_use=busy)
        self.assertEqual((second["XMPP_CLIENT_PORT"], second["XMPP_SERVER_PORT"]), ("5224", "5270"))
        kept = setup.collect_setup({"XMPP_DOMAIN": "one.example.org", "XMPP_CLIENT_PORT": "5222", "XMPP_SERVER_PORT": "5269"}, defaults, in_use=busy)
        self.assertEqual((kept["XMPP_CLIENT_PORT"], kept["XMPP_SERVER_PORT"]), ("5222", "5269"))

    def test_xmpp_srv_records_follow_the_ports_and_dns_only_target(self):
        settings = setup.collect_setup({"XMPP_DOMAIN": "two.example.org", "XMPP_CLIENT_PORT": "5223", "XMPP_SERVER_PORT": "5270", "XMPP_SRV_TARGET": "xmpp.example.org"}, defaults)
        self.assertEqual(setup.xmpp_dns_records(settings), [
            "_xmpp-client._tcp.two.example.org. SRV 0 5 5223 xmpp.example.org.",
            "_xmpp-server._tcp.two.example.org. SRV 0 5 5270 xmpp.example.org.",
            "_xmpp-server._tcp.channels.two.example.org. SRV 0 5 5270 xmpp.example.org.",
        ])
        self.assertEqual(setup.collect_setup({"XMPP_DOMAIN": "chat.example.org"}, defaults)["XMPP_SRV_TARGET"], "chat.example.org")
        for target in ("203.0.113.7", "Xmpp.example.org", "xmpp example"):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, "XMPP_SRV_TARGET"):
                setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_SRV_TARGET": target}, defaults)

    def test_xmpp_acme_certificates_need_consent_and_keep_dns_credentials_private(self):
        acme = {"XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "acme", "XMPP_ACME_EMAIL": "admin@example.org",
                "XMPP_ACME_ACCEPT_TOS": "true", "XMPP_ACME_DNS_PROVIDER": "cloudflare", "XMPP_ACME_DNS_CREDENTIALS": "CLOUDFLARE_DNS_API_TOKEN=to$ken#1"}
        settings = setup.collect_setup({**PROXY, **acme}, defaults, "traefik")
        self.assertIn("compose.xmpp-acme.yaml", settings["COMPOSE_FILE"])
        self.assertNotIn("compose.xmpp-acme-http.yaml", settings["COMPOSE_FILE"])
        self.assertEqual((settings["XMPP_ACME_CHALLENGE"], settings["XMPP_ACME_HTTP"]), ("dns", "false"))
        with tempfile.TemporaryDirectory() as directory:
            result = setup.write_setup(directory, settings)
            self.assertIn(Path(directory).resolve() / ".env.acme", result["files"])
            self.assertEqual(setup.parse_raw_env((Path(directory) / ".env.acme").read_text()), {"CLOUDFLARE_DNS_API_TOKEN": "to$ken#1"})
            self.assertNotIn("to$ken", (Path(directory) / ".env").read_text().replace("$$", "$"))
            self.assertNotIn("to$ken", (Path(directory) / ".env.container").read_text())
        with self.assertRaisesRegex(ValueError, "terms of service"):
            setup.collect_setup({**acme, "XMPP_ACME_ACCEPT_TOS": ""}, defaults)
        with self.assertRaisesRegex(ValueError, "XMPP_ACME_EMAIL"):
            setup.collect_setup({**acme, "XMPP_ACME_EMAIL": ""}, defaults)
        with self.assertRaisesRegex(ValueError, "XMPP_ACME_DNS_PROVIDER"):
            setup.collect_setup({**acme, "XMPP_ACME_DNS_PROVIDER": ""}, defaults)
        for credentials in ("token", "lower=value", "LEGO_SERVER=https://ca.example"):
            with self.subTest(credentials=credentials), self.assertRaisesRegex(ValueError, "XMPP_ACME_DNS_CREDENTIALS"):
                setup.collect_setup({**acme, "XMPP_ACME_DNS_CREDENTIALS": credentials}, defaults)
        http = setup.collect_setup({**acme, "XMPP_ACME_CHALLENGE": "http"}, defaults)
        self.assertIn("compose.xmpp-acme-http.yaml", http["COMPOSE_FILE"])
        self.assertEqual((http["XMPP_ACME_HTTP"], http["XMPP_ACME_DNS_PROVIDER"], http["XMPP_ACME_DNS_CREDENTIALS"]), ("true", "", ""))
        with self.assertRaisesRegex(ValueError, "port 80"):
            setup.collect_setup({**PROXY, **acme, "XMPP_ACME_CHALLENGE": "http"}, defaults, "proxy")

    def test_xmpp_http_challenges_use_a_separate_traefik_entrypoint(self):
        inputs = {**PROXY, "XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "acme",
                  "XMPP_ACME_EMAIL": "admin@example.org", "XMPP_ACME_ACCEPT_TOS": "true", "XMPP_ACME_CHALLENGE": "http"}
        settings = setup.collect_setup(inputs, defaults, "traefik")
        self.assertEqual(settings["XMPP_ACME_HTTP_ENTRYPOINT"], "web")
        self.assertEqual(settings["TRAEFIK_ENTRYPOINT"], "websecure")
        self.assertIn("compose.xmpp-acme-traefik.yaml", settings["COMPOSE_FILE"])
        self.assertNotIn("compose.xmpp-acme-http.yaml", settings["COMPOSE_FILE"])
        custom = setup.collect_setup({**settings, "XMPP_ACME_HTTP_ENTRYPOINT": "http"}, defaults)
        self.assertEqual(custom["XMPP_ACME_HTTP_ENTRYPOINT"], "http")
        self.assertEqual(custom["TRAEFIK_ENTRYPOINT"], "websecure")
        for entrypoint in ("web,websecure", "web/", "web\nlabel=true"):
            with self.subTest(entrypoint=entrypoint), self.assertRaisesRegex(ValueError, "XMPP_ACME_HTTP_ENTRYPOINT"):
                setup.collect_setup({**inputs, "XMPP_ACME_HTTP_ENTRYPOINT": entrypoint}, defaults, "traefik")
        standalone = setup.collect_setup(settings, defaults, "container")
        self.assertIn("compose.xmpp-acme-http.yaml", standalone["COMPOSE_FILE"])
        self.assertNotIn("compose.xmpp-acme-traefik.yaml", standalone["COMPOSE_FILE"])
        manual = setup.collect_setup({**settings, "XMPP_CERT_SOURCE": "manual"}, defaults)
        self.assertNotIn("compose.xmpp-acme-traefik.yaml", manual["COMPOSE_FILE"])

    def test_xmpp_can_reuse_the_traefik_resolver_and_its_certificate_store(self):
        traefik = {**PROXY, "TRAEFIK_CERT_RESOLVER": "letsencrypt", "XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "traefik"}
        def store(label, value, secret=False):
            return "/srv/traefik/letsencrypt/acme.json" if label == "Host path of Traefik's acme.json" else value
        settings = setup.collect_setup(traefik, store, "traefik")
        self.assertIn("compose.xmpp-traefik-certs.yaml", settings["COMPOSE_FILE"])
        self.assertEqual((settings["XMPP_TRAEFIK_ACME_DIR"], settings["XMPP_TRAEFIK_ACME_NAME"]), ("/srv/traefik/letsencrypt", "acme.json"))
        restored = setup.collect_setup(settings, defaults, "traefik")
        self.assertEqual((restored["XMPP_TRAEFIK_ACME_DIR"], restored["XMPP_TRAEFIK_ACME_NAME"]), ("/srv/traefik/letsencrypt", "acme.json"))
        with self.assertRaisesRegex(ValueError, "acme.json"):
            setup.collect_setup(traefik, defaults, "traefik")
        with self.assertRaisesRegex(ValueError, "certificate resolver"):
            setup.collect_setup({**traefik, "TRAEFIK_CERT_RESOLVER": ""}, store, "traefik")
        with self.assertRaisesRegex(ValueError, "Traefik mode"):
            setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "traefik"}, store)
        with self.assertRaisesRegex(ValueError, "XMPP_CERT_SOURCE"):
            setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "certbot"}, defaults)

    def test_default_is_loopback_container_without_development_auth(self):
        settings = setup.collect_setup({}, defaults)
        self.assertEqual(settings["SETUP_MODE"], "container")
        self.assertEqual(settings["HOST"], "0.0.0.0")
        self.assertEqual(settings["DEV_AUTH"], "false")
        self.assertEqual(settings["BASE_URL"], "http://127.0.0.1:8788")
        self.assertEqual(settings["DATABASE_PATH"], "/app/data/archipel.sqlite")
        self.assertEqual(settings["COMPOSE_FILE"], os.pathsep.join(("compose.yaml", "compose.local.yaml")))

    def test_legacy_local_mode_becomes_container(self):
        for requested, previous in (("local", {}), (None, {"SETUP_MODE": "local", "DEV_AUTH": "true"})):
            settings = setup.collect_setup(previous, defaults, requested)
            self.assertEqual(settings["SETUP_MODE"], "container")
            self.assertEqual(settings["DEV_AUTH"], "false")

    def test_traefik_network_entrypoint_and_certificate_resolver(self):
        settings = setup.collect_setup({**PROXY, "TRAEFIK_ENTRYPOINT": "https", "TRAEFIK_CERT_RESOLVER": "letsencrypt"}, defaults, "traefik")
        self.assertEqual(settings["PROXY_NETWORK"], "edge")
        self.assertEqual(settings["TRAEFIK_HOST"], "chat.example.org")
        self.assertEqual(settings["TRAEFIK_ENTRYPOINT"], "https")
        self.assertEqual(settings["COMPOSE_FILE"], os.pathsep.join(("compose.yaml", "compose.proxy.yaml", "compose.traefik.yaml", "compose.acme.yaml")))
        self.assertEqual(setup.parse_trusted_proxies(settings["TRUSTED_PROXY"]), ["172.20.0.2"])

    def test_instances_sharing_a_machine_get_their_own_names(self):
        self.assertEqual(setup.collect_setup({}, defaults)["COMPOSE_PROJECT_NAME"], "archipel")
        self.assertEqual(setup.collect_setup({"COMPOSE_PROJECT_NAME": "archipel2"}, defaults)["COMPOSE_PROJECT_NAME"], "archipel2")
        self.assertEqual(setup.project_name("Archipel Two.prod"), "archipeltwoprod")
        for name in ("", "Two", "a b", "-two", "a.b"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "COMPOSE_PROJECT_NAME"):
                setup.validate_setup({**setup.collect_setup({}, defaults), "COMPOSE_PROJECT_NAME": name})
        with tempfile.TemporaryDirectory(prefix="Second Instance ") as directory:
            env = {**os.environ, "SETUP_MODE": "container"}
            env.pop("COMPOSE_PROJECT_NAME", None)
            subprocess.run([sys.executable, str(ROOT / "scripts" / "setup.py"), "--non-interactive", "--directory", directory], env=env, check=True, capture_output=True)
            written = setup.parse_env((Path(directory) / ".env").read_text())["COMPOSE_PROJECT_NAME"]
            self.assertEqual(written, setup.project_name(Path(directory).resolve().name))

    def test_generic_proxy_external_network_and_host_loopback(self):
        external = setup.collect_setup(PROXY, defaults, "proxy")
        self.assertEqual(external["COMPOSE_FILE"], os.pathsep.join(("compose.yaml", "compose.proxy.yaml")))
        def decline_network(label, value, secret=False):
            return "no" if label.startswith("Use an existing") else value
        host = setup.collect_setup(PROXY, decline_network, "proxy")
        self.assertEqual(host["PROXY_NETWORK"], "")
        self.assertEqual(host["COMPOSE_FILE"], os.pathsep.join(("compose.yaml", "compose.local.yaml")))

    def test_proxy_trust_requires_explicit_ips_or_bounded_cidrs(self):
        self.assertEqual(setup.parse_trusted_proxies("172.20.0.2,2001:db8::2,172.21.0.0/24,::1/128,172.20.0.2"), ["172.20.0.2", "2001:db8::2", "172.21.0.0/24", "::1/128"])
        for value in ("true", "1", "loopback", "proxy", "0.0.0.0/0", "::/0", "1.2.3.4/33", "::1/129", "1.2.3.4/", "1.2.3.4,"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "TRUSTED_PROXY"):
                setup.parse_trusted_proxies(value)

    def test_incomplete_or_unsafe_configuration_is_rejected(self):
        for override, field in (({"TRUSTED_PROXY": ""}, "TRUSTED_PROXY"), ({"PROXY_NETWORK": "bad network"}, "network"), ({"OIDC_CLIENT_ID": ""}, "OIDC_CLIENT_ID"), ({"OIDC_ISSUER": "http://127.0.0.1"}, "OIDC_ISSUER"), ({"OIDC_AUTH_METHOD": "unknown"}, "OIDC_AUTH_METHOD"), ({"OIDC_AUTH_METHOD": "client_secret_basic"}, "OIDC_CLIENT_SECRET"), ({"TRAEFIK_ENTRYPOINT": "bad label!"}, "TRAEFIK_ENTRYPOINT"), ({"PORT": "65536"}, "PORT"), ({"REGISTRATION_MODE": "invalid"}, "REGISTRATION_MODE")):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                setup.collect_setup({**PROXY, **override}, defaults, "traefik")
        settings=setup.collect_setup(PROXY,defaults,'traefik')
        with self.assertRaisesRegex(ValueError,'HTTPS'):
            setup.validate_setup({**settings,'BASE_URL':'http://127.0.0.1'})

    def test_url_origins_and_trailing_slash(self):
        settings = setup.collect_setup({**PROXY, "BASE_URL": "https://chat.example.org/"}, defaults, "traefik")
        self.assertEqual(settings["BASE_URL"], "https://chat.example.org")
        for url in ("https://name:secret@example.org", "https://example.org/path", "https://example.org?query", "https://example.org#fragment", "https://example.org:bad", "https://bad host", "file:///etc/passwd"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "BASE_URL"):
                setup.collect_setup({"BASE_URL": url}, defaults)

    def test_secret_uses_literal_raw_file_with_private_permissions(self):
        secret = "dollars$VARIABLE#'\"`\\keep"
        settings = setup.collect_setup({**PROXY, "OIDC_AUTH_METHOD": "client_secret_basic", "OIDC_CLIENT_SECRET": secret}, defaults, "traefik")
        with tempfile.TemporaryDirectory() as directory:
            result = setup.write_setup(directory, settings)
            self.assertEqual(setup.parse_raw_env((Path(directory) / ".env.container").read_text())["OIDC_CLIENT_SECRET"], secret)
            self.assertEqual(setup.parse_env((Path(directory) / ".env").read_text())["OIDC_CLIENT_SECRET"], "")
            for file in result["files"]:
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_reconfiguration_preserves_custom_variables_and_private_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("CUSTOM_SETTING=keep\n")
            settings = setup.collect_setup({"CUSTOM_SETTING": "keep"}, defaults)
            result = setup.write_setup(directory, settings)
            self.assertEqual(result["backups"][0].read_text(), "CUSTOM_SETTING=keep\n")
            self.assertEqual(result["backups"][0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(setup.parse_env(path.read_text())["CUSTOM_SETTING"], "keep")
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                setup.write_setup(directory, {**settings, "TRUSTED_PROXY": "true"})
            self.assertEqual(path.read_bytes(), before)

    def test_new_env_format_round_trips_dollars_quotes_and_backslashes(self):
        values = {"CUSTOM_SETTING": "dollars$$VARIABLE#'\"`\\keep", "TRAILING": "slash\\", "SUBJECT": "backslash\\'quote"}
        self.assertEqual(setup.parse_env(setup.serialize_env(values)), values)
        for invalid in ("line\nbreak", "line\rbreak", "nul\0value"):
            with self.assertRaises(ValueError):
                setup.serialize_env({"CUSTOM_SETTING": invalid})

    def test_previous_generated_node_env_format_can_be_loaded(self):
        source = "# Generated by npm run setup.\nSETUP_MODE='traefik'\nCUSTOM_SETTING=\"has'quote$literal\\keep\"\nOTHER=`has'both\"quotes`\nexport SIMPLE=keep # comment\n"
        self.assertEqual(setup.parse_env(source), {"SETUP_MODE": "traefik", "CUSTOM_SETTING": "has'quote$literal\\keep", "OTHER": "has'both\"quotes", "SIMPLE": "keep"})

    def test_invalid_env_is_data_and_never_executed(self):
        values = {"CUSTOM_SETTING": "$(touch must-not-exist)`echo unsafe`"}
        self.assertEqual(setup.parse_env(setup.serialize_env(values)), values)
        for source in ("BROKEN", "SETUP_MODE='unterminated", "A='good' trailing", "A='line\nbreak'"):
            with self.assertRaises(ValueError):
                setup.parse_env(source)

    def test_hidden_prompt_keeps_or_clears_secret_without_showing_it(self):
        for answer, expected in (("", "existing-private-value"), ("-", ""), ("new-value", "new-value")):
            with patch.object(setup.getpass, "getpass", return_value=answer) as ask:
                self.assertEqual(setup.prompt("OIDC client secret", "existing-private-value", True), expected)
                self.assertNotIn("existing-private-value", ask.call_args.args[0])

    def run_cli(self, directory, mode="traefik", extra_env=None, arguments=()):
        # Empty PATH proves setup cannot invoke Node/npm or other host programs.
        env = {key: value for key, value in os.environ.items() if key not in (*setup.APP_KEYS, *setup.XMPP_SETUP_KEYS, "SETUP_MODE", "PROXY_NETWORK", "TRAEFIK_ENTRYPOINT", "TRAEFIK_CERT_RESOLVER")}
        env.update({**{key:value for key,value in PROXY.items() if key!='OIDC_AUTH_METHOD'}, "PATH": "", **(extra_env or {})})
        return subprocess.run([sys.executable, str(ROOT / "scripts/setup.py"), "--non-interactive", "--mode", mode, "--directory", str(directory), *arguments], capture_output=True, text=True, env=env)

    def test_cli_runs_without_node_npm_or_pip_and_never_echoes_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(directory, extra_env={"OIDC_AUTH_METHOD": "client_secret_basic", "OIDC_CLIENT_SECRET": "private$#secret"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("private$#secret", result.stdout + result.stderr)
            self.assertIn("docker compose up --build -d", result.stdout)
            self.assertIn("https://chat.example.org/auth/callback", result.stdout)
            self.assertEqual(setup.parse_raw_env((Path(directory) / ".env.container").read_text())["OIDC_CLIENT_SECRET"], "private$#secret")
            self.assertNotIn("npm", result.stdout)

    def test_cli_routes_http_challenges_through_the_supplied_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(directory, extra_env={"XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "acme",
                "XMPP_ACME_EMAIL": "admin@example.org", "XMPP_ACME_ACCEPT_TOS": "true", "XMPP_ACME_CHALLENGE": "http", "XMPP_ACME_HTTP_ENTRYPOINT": "http"})
            self.assertEqual(result.returncode, 0, result.stderr)
            settings = setup.parse_env((Path(directory) / ".env").read_text())
            self.assertEqual(settings["XMPP_ACME_HTTP_ENTRYPOINT"], "http")
            self.assertIn("compose.xmpp-acme-traefik.yaml", settings["COMPOSE_FILE"])
            self.assertNotIn("compose.xmpp-acme-http.yaml", settings["COMPOSE_FILE"])
            self.assertIn("--entryPoints.http.allowACMEByPass=true", result.stdout)
            self.assertIn("no extra host port", result.stdout)

    def test_cli_reuses_previous_secret_and_can_clear_it_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.run_cli(directory, extra_env={"OIDC_AUTH_METHOD": "client_secret_basic", "OIDC_CLIENT_SECRET": "keep$#secret"})
            self.assertEqual(first.returncode, 0, first.stderr)
            second = self.run_cli(directory)
            self.assertEqual(second.returncode, 0, second.stderr)
            raw = Path(directory) / ".env.container"
            self.assertEqual(setup.parse_raw_env(raw.read_text())["OIDC_CLIENT_SECRET"], "keep$#secret")
            backups = list(Path(directory).glob(".env*.backup.*"))
            self.assertEqual(len(backups), 2)
            self.assertTrue(all(file.stat().st_mode & 0o777 == 0o600 for file in backups))
            third = self.run_cli(directory, extra_env={"OIDC_AUTH_METHOD": "none", "OIDC_CLIENT_SECRET": ""})
            self.assertEqual(third.returncode, 0, third.stderr)
            self.assertEqual(setup.parse_raw_env(raw.read_text())["OIDC_CLIENT_SECRET"], "")

    def test_interactive_cli_requires_terminal_and_bad_options_write_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(ROOT / "scripts/setup.py"), "--directory", directory], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("requires a terminal", result.stderr)
            invalid = self.run_cli(directory, arguments=("--bogus",))
            self.assertNotEqual(invalid.returncode, 0)
            self.assertFalse((Path(directory) / ".env").exists())

    def test_invalid_cli_configuration_does_not_replace_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.run_cli(directory)
            self.assertEqual(first.returncode, 0, first.stderr)
            path = Path(directory) / ".env"
            before = path.read_bytes()
            result = self.run_cli(directory, extra_env={"TRUSTED_PROXY": "true"})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), before)

    def test_invite_only_initial_policy(self):
        settings = setup.collect_setup({"REGISTRATION_MODE": "invite_only"}, defaults)
        self.assertEqual(settings["REGISTRATION_MODE"], "invite_only")


class ComposeTests(unittest.TestCase):
    # Keep this optional: Python-only setup tests do not require Docker installed.
    def test_real_compose_validates_each_overlay_and_literal_credentials(self):
        executable = os.environ.get("ARCHIPEL_TEST_COMPOSE") or shutil.which("docker-compose")
        if executable:
            command = [executable]
        elif shutil.which("docker"):
            command = [shutil.which("docker"), "compose"]
        else:
            self.skipTest("Docker Compose is not installed")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for file in ROOT.glob("compose*.yaml"):
                shutil.copyfile(file, path / file.name)
            for mode, inputs in (("container", {}), ("proxy", PROXY), ("traefik", {**PROXY, "TRAEFIK_CERT_RESOLVER": "letsencrypt"})):
                with self.subTest(mode=mode):
                    settings = setup.collect_setup({**inputs, "OIDC_ISSUER": "https://identity.example.org", "OIDC_CLIENT_ID": "archipel", "OIDC_AUTH_METHOD": "client_secret_basic", "OIDC_CLIENT_SECRET": "dollars$VARIABLE#'\"`\\keep"}, defaults, mode)
                    setup.write_setup(directory, settings)
                    env = {key: value for key, value in os.environ.items() if key not in (*settings, "COMPOSE_FILE", "COMPOSE_PROJECT_NAME")}
                    result = subprocess.run([*command, "config", "--format", "json"], cwd=directory, env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    service = json.loads(result.stdout)["services"]["archipel"]
                    self.assertEqual(service["environment"]["OIDC_CLIENT_SECRET"].replace("$$", "$"), settings["OIDC_CLIENT_SECRET"])
                    self.assertEqual(service["environment"]["BASE_URL"], settings["BASE_URL"])
                    self.assertEqual(service["environment"]["DEV_AUTH"], "false")
                    if mode != "container":
                        self.assertEqual(service["environment"]["TRUSTED_PROXY"], "172.20.0.2")
                        self.assertNotIn("ports", service)
                        self.assertTrue(json.loads(result.stdout)["networks"]["proxy"]["external"])
                    else:
                        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
                    if mode == "traefik":
                        self.assertEqual(service["labels"]["traefik.http.routers.archipel.tls.certresolver"], "letsencrypt")
                        second = subprocess.run([*command, "config", "--format", "json"], cwd=directory, env={**env, "COMPOSE_PROJECT_NAME": "archipel2"}, capture_output=True, text=True)
                        self.assertEqual(second.returncode, 0, second.stderr)
                        labels = json.loads(second.stdout)["services"]["archipel"]["labels"]
                        self.assertEqual(labels["traefik.http.routers.archipel2.service"], "archipel2")
                        self.assertEqual(labels["traefik.http.services.archipel2.loadbalancer.server.port"], "8788")
                        self.assertFalse([key for key in labels if ".archipel." in key])
            settings = setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_CLIENT_PORT": "55222", "XMPP_SERVER_PORT": "55269"}, defaults)
            setup.write_setup(directory, settings)
            env = {key: value for key, value in os.environ.items() if key not in (*settings, "COMPOSE_FILE", "COMPOSE_PROJECT_NAME")}
            result = subprocess.run([*command, "config", "--format", "json"], cwd=directory, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            services = json.loads(result.stdout)["services"]
            for service in ("archipel", "prosody"):
                self.assertEqual(services[service]["environment"]["XMPP_CLIENT_PORT"], "55222")
                self.assertEqual(services[service]["environment"]["XMPP_SERVER_PORT"], "55269")
            self.assertEqual({(p["published"], p["target"]) for p in services["prosody"]["ports"]}, {("55222", 55222), ("55269", 55269)})
            config = lambda: subprocess.run([*command, "config", "--format", "json"], cwd=directory, capture_output=True, text=True,
                env={key: value for key, value in os.environ.items() if key not in (*settings, "COMPOSE_FILE", "COMPOSE_PROJECT_NAME")})
            settings = setup.collect_setup({"XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "acme", "XMPP_ACME_EMAIL": "admin@example.org",
                "XMPP_ACME_ACCEPT_TOS": "true", "XMPP_ACME_DNS_PROVIDER": "cloudflare", "XMPP_ACME_DNS_CREDENTIALS": "CLOUDFLARE_DNS_API_TOKEN=to$ken"}, defaults)
            setup.write_setup(directory, settings)
            result = config()
            self.assertEqual(result.returncode, 0, result.stderr)
            services = json.loads(result.stdout)["services"]
            issuer = services["xmpp-acme"]["environment"]
            self.assertEqual(issuer["LEGO_DOMAINS"], "chat.example.org,channels.chat.example.org")
            self.assertEqual((issuer["LEGO_DNS"], issuer["LEGO_HTTP"], issuer["LEGO_ACCEPT_TOS"]), ("cloudflare", "false", "true"))
            self.assertEqual(issuer["CLOUDFLARE_DNS_API_TOKEN"].replace("$$", "$"), "to$ken")
            self.assertNotIn("ports", services["xmpp-acme"])
            self.assertNotIn("CLOUDFLARE_DNS_API_TOKEN", services["prosody"]["environment"])
            self.assertEqual(services["prosody"]["environment"]["XMPP_CERT_SOURCE"], "acme")
            self.assertEqual(services["prosody"]["entrypoint"], ["sh", "/etc/prosody/certs.sh"])
            settings = setup.collect_setup({**settings, "XMPP_ACME_CHALLENGE": "http"}, defaults)
            setup.write_setup(directory, settings)
            result = config()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["services"]["xmpp-acme"]["ports"][0]["target"], 80)
            for entrypoint in ("web", "http"):
                settings = setup.collect_setup({**settings, **PROXY, "COMPOSE_PROJECT_NAME": "archipel2", "XMPP_ACME_HTTP_ENTRYPOINT": entrypoint,
                    "TRAEFIK_CERT_RESOLVER": "letsencrypt"}, defaults, "traefik")
                setup.write_setup(directory, settings)
                result = config()
                self.assertEqual(result.returncode, 0, result.stderr)
                parsed = json.loads(result.stdout)
                acme_service = parsed["services"]["xmpp-acme"]
                self.assertNotIn("ports", acme_service)
                self.assertEqual(set(acme_service["networks"]), {"proxy"})
                self.assertEqual(parsed["networks"]["proxy"]["name"], "edge")
                labels = acme_service["labels"]
                router = "traefik.http.routers.archipel2-xmpp-acme."
                self.assertEqual(labels["traefik.docker.network"], "edge")
                self.assertEqual(labels[router + "entrypoints"], entrypoint)
                self.assertEqual(labels[router + "rule"], "(Host(`chat.example.org`) || Host(`channels.chat.example.org`)) && PathPrefix(`/.well-known/acme-challenge/`)")
                self.assertEqual(labels[router + "service"], "archipel2-xmpp-acme")
                self.assertEqual(labels["traefik.http.services.archipel2-xmpp-acme.loadbalancer.server.port"], "80")
                self.assertFalse(any(".tls" in key or "archipel-xmpp" in key for key in labels))
                self.assertEqual(acme_service["environment"]["LEGO_HTTP"], "true")
                self.assertNotIn("CLOUDFLARE_DNS_API_TOKEN", acme_service["environment"])
                app_labels = parsed["services"]["archipel"]["labels"]
                self.assertEqual(app_labels["traefik.http.routers.archipel2.entrypoints"], "websecure")
                self.assertEqual(app_labels["traefik.http.routers.archipel2.tls.certresolver"], "letsencrypt")
            settings = setup.collect_setup({**PROXY, "TRAEFIK_CERT_RESOLVER": "letsencrypt", "XMPP_DOMAIN": "chat.example.org", "XMPP_CERT_SOURCE": "traefik",
                "XMPP_TRAEFIK_ACME_DIR": "/srv/traefik", "XMPP_TRAEFIK_ACME_NAME": "acme.json"}, defaults, "traefik")
            setup.write_setup(directory, settings)
            result = config()
            self.assertEqual(result.returncode, 0, result.stderr)
            services = json.loads(result.stdout)["services"]
            labels = services["archipel"]["labels"]
            self.assertEqual(labels["traefik.http.routers.archipel-xmpp-certs.tls.domains[0].main"], "chat.example.org")
            self.assertEqual(labels["traefik.http.routers.archipel-xmpp-certs.tls.domains[0].sans"], "channels.chat.example.org")
            self.assertEqual(labels["traefik.http.routers.archipel-xmpp-certs.tls.certresolver"], "letsencrypt")
            self.assertEqual(services["prosody"]["environment"]["XMPP_TRAEFIK_ACME_FILE"], "/traefik/acme.json")
            self.assertIn(("/srv/traefik", "/traefik", True), {(v["source"], v["target"], v.get("read_only", False)) for v in services["prosody"]["volumes"]})


if __name__ == "__main__":
    unittest.main()
