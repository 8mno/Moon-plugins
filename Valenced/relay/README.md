# Quest relay

Discord decides which quests you can see from the IP address it sees. This relay is a tiny server you run
in the country a quest is limited to. The Quest Inspector plugin sends it the accept request and the relay
repeats it from its own IP. It can only do `POST /quests/{id}/enroll` and `GET /quests/{id}`.

Your Discord token is sent to the relay with each request, so **only run it on a server you control**, and
only behind HTTPS (the plugin ignores `http://` addresses). The relay never stores or logs the token.

## Run it (Node 18+, no packages)

```
RELAY_KEY=$(openssl rand -hex 16) COUNTRY=DE node quest-relay.js
```

It listens on `127.0.0.1:8787` (change with `HOST` / `PORT`). Put HTTPS in front of it, for example Caddy:

```
de.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Plugin settings (Quest Inspector, "Relay" section)

- Relays: `DE=https://de.example.com US=https://us.example.com` (one per country; a bare `https://...` is a default)
- Relay key: the `RELAY_KEY` you started it with
- "Test relays" asks each server which country it really is in and warns if it differs from your code.

The plugin picks the relay from the quest's region list on its own: the countries it is limited to, or any relay
whose country is not on its exclude list. Quests with no matching relay are sent from your phone as before.

Risks: using one account from two countries can trigger Discord's account checks, a datacenter IP may be treated
differently from a home or phone IP, and the server can still answer "Unknown quest".
