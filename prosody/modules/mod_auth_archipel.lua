local bridge = module:require "archipel";
local new_sasl = require "prosody.util.sasl".new;
local provider = {};
function provider.get_sasl_handler(session)
  return new_sasl(module.host, {
    plain_test = function(_, username, password)
      local result = bridge.request("/auth", { username = username; password = password });
      if result and result.valid then session.archipel_credential = result.credential; return true, true; end
      return false, true;
    end;
  });
end
-- Existence is checked only against explicit bindings, never username claims.
function provider.user_exists(username)
  local result = bridge.request("/operation", { operation = "exists"; username = username });
  return result and result.exists or false;
end
function provider.test_password() return nil, "Use SASL PLAIN over TLS with an app password"; end
function provider.set_password() return nil, "Manage credentials in Archipel Web"; end
function provider.create_user() return nil, "Sign in to Archipel Web using OIDC"; end
function provider.delete_user() return nil, "Manage accounts in Archipel Web"; end
module:provides("auth", provider);
