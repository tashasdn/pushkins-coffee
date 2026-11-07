import { setupHandler } from "../_shared/core.js";

Deno.serve(setupHandler(name => Deno.env.get(name)));
