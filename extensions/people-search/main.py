"""people-search: public-records people search, the module people.py on the server in server.py."""
import people  # noqa: F401  (it declares its tools, events and loops on server.app)
from server import app

if __name__ == "__main__":
    app.run()
