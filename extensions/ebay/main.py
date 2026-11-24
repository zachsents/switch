"""ebay: eBay sold prices and live listings, the module ebay.py on the server in server.py."""
import ebay  # noqa: F401  (it declares its tools, events and loops on server.app)
from server import app

if __name__ == "__main__":
    app.run()
