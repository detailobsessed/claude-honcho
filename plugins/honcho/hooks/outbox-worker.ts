#!/usr/bin/env bun
import { initHook } from "../src/config.js";
import { handleOutboxWorker } from "../src/hooks/outbox-worker.js";

await initHook();
await handleOutboxWorker();
