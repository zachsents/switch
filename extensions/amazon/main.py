"""amazon: Amazon reorders and cart checkouts, the module amazon.py on the server in server.py."""
import amazon  # noqa: F401  (it declares its tools, events, widgets and loops on server.app)
from server import app

if __name__ == "__main__":
    app.run()
