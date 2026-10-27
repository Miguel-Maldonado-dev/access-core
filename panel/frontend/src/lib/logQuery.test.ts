import { describe, expect, it } from "vitest";
import { buildLogQuery } from "./logQuery";

describe("buildLogQuery", () => {
  it("incluye todos los filtros y la paginación", () => {
    expect(
      buildLogQuery({ dateFrom: "2026-10-01", dateTo: "2026-10-10", holderId: 1, allowed: false, source: 1 }, 2, 50),
    ).toBe("date_from=2026-10-01&date_to=2026-10-10&holder_id=1&allowed=false&source=1&page=2&page_size=50");
  });

  it("sin filtros solo lleva la paginación", () => {
    expect(buildLogQuery({}, 1, 50)).toBe("page=1&page_size=50");
  });

  it("conserva los valores falsos válidos (holderId 0, source 0)", () => {
    expect(buildLogQuery({ holderId: 0, source: 0, allowed: true }, 1, 50)).toBe(
      "holder_id=0&allowed=true&source=0&page=1&page_size=50",
    );
  });
});
