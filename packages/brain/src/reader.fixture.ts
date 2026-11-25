// The readers test's reader thread: its reads, then served.
import { serveReads } from "./readers.ts"
import "./reads.fixture.ts"

serveReads()
