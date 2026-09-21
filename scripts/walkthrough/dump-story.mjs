/** Serialises scenes.mjs to JSON for the Python card stage. */
import { writeJson, OUT } from "./lib.mjs";
import { scenes } from "./scenes.mjs";
writeJson(OUT + "/story.json", scenes);
