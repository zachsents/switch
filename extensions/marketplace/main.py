"""marketplace: Facebook Marketplace as one extension: search and saved searches (search.py), and chats and messages to
sellers and buyers (chats.py), on the one server in server.py."""
import chats  # noqa: F401  (its tools, widget and loop)
import search  # noqa: F401  (its tools, widget and loops)
from server import app

if __name__ == "__main__":
    app.run()
