#!/usr/bin/env node
import { execute, isMain } from "./workflow-lib.mjs";
import { main } from "./prepare-workspaces.mjs";

if (isMain(import.meta.url)) execute(() => main());
