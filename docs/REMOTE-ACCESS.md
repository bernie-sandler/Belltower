# Phone and remote access

Tower Tracker is meant to stay inside your home network or tailnet. Here are the two ways to reach it from your
phone, plus how to make it feel like an app.

## Option A: Tailscale straight to the server (simplest)

Use this if Tailscale runs on Unraid itself, or another machine on your LAN acts as a Tailscale **subnet router**.

- On the phone, open `http://tower:8080` (with MagicDNS) or `http://<tailscale-or-lan-ip>:8080`.
- Plain HTTP is fine here. The Tailscale tunnel is already encrypted, and everything in the app works over it.
- Leave `TRUST_PROXY` empty.

**Want HTTPS anyway?** `tailscale serve` (or Unraid 7's per-container Tailscale) gives the app an
`https://<name>.<tailnet>.ts.net` address that only your tailnet can reach. No proxy needed.

## Option B: an HTTPS name through Nginx Proxy Manager

This gives you something like `https://tracker.example.com`. One thing to know first: if ports 80 and 443 are
forwarded to NPM, a proxy host is reachable from the whole internet by anyone who knows or guesses its name. So do
all four steps.

1. **Add a proxy host.** Forward `http` to `<unraid-ip>` on the app's `PORT`. Turning on **Websockets Support** is
   harmless.
2. **Lock it down with an access list.** Under **Access Lists → Add**, allow your LAN (for example
   `192.168.1.0/24`) and Tailscale (`100.64.0.0/10`), deny everything else, and select that list on the proxy host.
   Without it, the app's password is the only thing standing between the internet and your board.
3. **Raise the upload limit.** On the proxy host's **Advanced** tab, add `client_max_body_size 2048m;` (or at least
   your `MAX_UPLOAD_MB`). Otherwise uploads and restores bigger than about 1 MB fail.
4. **Tell the app about the proxy.** Set `TRUST_PROXY=<NPM's LAN IP>` in `.env` and run `docker compose up -d`. The
   login limiter then sees real client addresses instead of the proxy's, and cookies get the Secure flag over
   HTTPS.

Sharing the [submit page](SUBMIT-PAGE.md#sharing-it-outside-your-network) beyond your network needs a small
exception to that access list; the submit page doc explains it.

## Add it to your Home Screen

On an iPhone, open the app in Safari, tap **Share**, then **Add to Home Screen**. It opens full-screen like a regular
app.

The Home Screen app keeps its own login, separate from Safari, so sign in once there and tick **Remember this
device**.

## On a phone

- **Moving cards:** long-press a card to pick it up, or use **Move to…** in the card.
- **Columns:** swipe across the board, or tap a column's pill at the top to jump to it.
- **Screenshots:** paste one straight into a card, or attach from Photos.
