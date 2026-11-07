import { hookHandler } from "../_shared/core.js";

Deno.serve(hookHandler(name => Deno.env.get(name)));
