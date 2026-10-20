#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
