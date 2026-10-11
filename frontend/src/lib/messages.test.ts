import { describe, expect, it } from "vitest";
import { deleteHolderMessage } from "./messages";
import type { Holder } from "./types";

const base: Holder = {
  holder_id: 1, kind: "persona", name: "Amadeo 1260", department: "", address: "",
  notes: "", permission_ids: [], card_count: 2, control_count: 1,
};

describe("deleteHolderMessage", () => {
  it("cuenta tarjetas y controles", () => {
    expect(deleteHolderMessage(base)).toBe(
      '¿Borrar "Amadeo 1260"? También se borrarán sus 2 tarjetas y 1 control.',
    );
  });
  it("singulariza y pluraliza", () => {
    expect(deleteHolderMessage({ ...base, card_count: 1, control_count: 3 })).toBe(
      '¿Borrar "Amadeo 1260"? También se borrarán sus 1 tarjeta y 3 controles.',
    );
  });
  it("no menciona nada si no tiene tarjetas ni controles", () => {
    expect(deleteHolderMessage({ ...base, card_count: 0, control_count: 0 })).toBe('¿Borrar "Amadeo 1260"?');
  });
});
