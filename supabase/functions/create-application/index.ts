import { applicationHandler } from "../_shared/core.js";

Deno.serve(applicationHandler(name => Deno.env.get(name)));
