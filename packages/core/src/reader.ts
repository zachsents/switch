// A brain reader thread (the brain's readers.ts): every module the core reads from loaded, as the
// core loads them, so it knows each read by name; then the reads it's asked for, off the core's
// event loop.
import { knowProjections, serveReads } from "@switch/brain"

import { brainParts } from "./server.ts"

knowProjections(brainParts.flatMap((p) => p.projections))
serveReads()
