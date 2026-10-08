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
        env = {key: value for key, value in os.environ.items() if key not in (*setup.APP_KEYS, "SETUP_MODE", "PROXY_NETWORK", "TRAEFIK_ENTRYPOINT", "TRAEFIK_CERT_RESOLVER")}
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


if __name__ == "__main__":
    unittest.main()
