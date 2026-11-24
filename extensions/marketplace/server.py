"""The marketplace extension's one MCP server, which search.py and chats.py both declare their tools on."""
import sbmcp

app = sbmcp.Server("marketplace", version="1", instructions=(
    "The user's Facebook Marketplace, through their own Chrome signed in to Facebook (the browser extension). "
    "Search: search takes several queries, a place and a radius and answers the listings deduped, with price, place, "
    "approximate miles and age (details reads the top ones' descriptions, condition and seller rating); listing reads one "
    "listing in full, with its photos as files; watch saves a search that's scanned on a schedule and records what's new "
    "and price drops; scan, unwatch and watches manage them. Searching only reads: it never messages a seller, saves or offers. "
    "Chats: the user's Marketplace chats, buying and selling, read from the Marketplace inbox every few minutes (2.5 while an "
    "offer is out, 6 by day, 20 at night), each emitted as a chat event whenever its latest message or read state changes "
    "(new_from_them marks the first sight of a new message from the other side); it never opens an unread chat, and check "
    "reads the inbox now. To message a seller or buyer (an offer, a question, a reply), in the user's name: draft reads the "
    "listing and chat and says what sending would go into (sending nothing); send sends the words, confirms they're in the "
    "chat, and emits a send event. status says how the search half stands."),
    connections=[{"provider": "facebook", "kind": "session", "label": "Facebook", "scopes": [], "multiple": False}],
    reaches={"calls": ["browser_act", "browser_run"]}, notifies=True)

app.event("listing", "A listing a saved search found: new, or its price changed", stream="market/marketplace", kind="observation")
app.event("notice", "A new listing or price cut on a saved search the user asked to hear of", stream="market/marketplace-notices", kind="observation")
app.event("scan", "A saved search's scan: what it is and what changed since the last one", stream="market/marketplace-scans", kind="observation")
app.event("watch_gone", "A saved search was stopped", stream="market/marketplace-scans", kind="gone")
app.event("chat", "A Marketplace chat, buying or selling: a new message, who's waiting on whom", stream="comms/marketplace", kind="observation")
app.event("ask", "Something the user must do: sign in to Facebook again", stream="asks", kind="ask")
app.event("send", "A message sent (or held back) to a Marketplace seller or buyer in the user's name", stream="comms/marketplace-sends", kind="observation")
app.event("heartbeat", "How it is itself (sense:marketplace-search for the search, sense:marketplace-chats for the chats)", stream="vitals/marketplace", kind="observation", retention="signal")


_live = set()


def session_live(provider):
    """The browser is signed in for it: the user's connection for it says so, once (a session holds no secret here)."""
    if provider in _live:
        return
    try:
        if not app.accounts(provider):
            app.adopt(provider, "default", {})
            app.log(f"{provider}: the browser's sign-in is the connection")
        _live.add(provider)
    except Exception as e:  # noqa: BLE001  (never stops the work it was seen in)
        app.log(f"{provider}: couldn't record the sign-in: {e}")
