import { cuttingToolType, type CamCuttingGeometry, type CamResult } from "../../cam/src/index";
import type { WhittleDocument } from "./model";
import { documentEvaluator } from "./params";
import { LENGTH_TO_MM } from "./units";

/** Read document-level native parameters from the validated source part snapshot. */
export function sourceToolParameters(source: WhittleDocument): CamResult<CamCuttingGeometry> {
  const evaluator = documentEvaluator(source);
  const parameters = new Map(source.parameters.map((parameter) => [parameter.name.toUpperCase(), parameter]));
  function number(name: string, length: boolean, required = false): number | undefined {
    const parameter = parameters.get(name);
    if (!parameter) {
      if (required) throw new Error(`The cutting part is missing ${name}.`);
      return undefined;
    }
    if (source.parameters.filter((entry) => entry.name.toUpperCase() === name).length !== 1) {
      throw new Error(`The cutting part has multiple parameters named ${name}.`);
    }
    const kind = parameter.kind;
    if (kind !== "number" && kind !== "count" && !(length && kind === "length")) {
      throw new Error(`${name} must be ${length ? "a length in part units" : "a dimensionless integer"}.`);
    }
    const raw = evaluator.num(kind === "count" ? parameter.expr : parameter.name,
      kind === "length" ? "length" : "number", name);
    const value = length && kind !== "length" ? raw * LENGTH_TO_MM[source.units] : raw;
    if (!Number.isFinite(value) || (length && value <= 0)) throw new Error(`${name} must be ${length ? "positive" : "finite"}.`);
    return value;
  }

  try {
    const type = number("TYPE", false, true)!;
    const family = cuttingToolType(type);
    if (!family) throw new Error(`Unknown cutting part TYPE ${type}. Use an integer from 0 through 5.`);
    return { ok: true, value: {
      type, family, diameter: number("CUTTER_DIAMETER", true, true)!,
      cutterLength: number("CUTTER_LENGTH", true),
      fluteLength: number("FLUTE_LENGTH", true),
      shankDiameter: number("CORP_DIAMETER", true),
    } };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
