// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rol = vi.hoisted(() => ({ value: "admin" }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/auth/guards", () => ({
  guardPage: async <T,>(p: Promise<T>) => p,
  requireTenantRole: async () => ({ role: rol.value }),
}));
vi.mock("@/lib/installations", () => ({
  getInstallationForPage: async () => ({ id: "i-1", name: "Villa Real", revision: 1 }),
}));
vi.mock("@/lib/logs", () => ({
  listLogFilterOptionsAs: async () => ({ panels: [], holders: [] }),
  listLogsAs: async () => ({ rows: [], page: 1, pageSize: 50, total: 0 }),
}));
vi.mock("@/app/t/[tenant]/installations/[id]/logs/actions", () => ({
  logsUploadStatus: vi.fn(),
  purgeLogs: vi.fn(),
  requestLogsUpload: vi.fn(),
}));

import LogsPage from "@/app/t/[tenant]/installations/[id]/logs/page";

afterEach(cleanup);

async function pagina() {
  const ui = await LogsPage({
    params: Promise.resolve({ tenant: "t", id: "i-1" }),
    searchParams: Promise.resolve({}),
  } as never);
  render(ui);
}

describe("Página de logs", () => {
  it("Borrar logs solo se muestra al admin", async () => {
    rol.value = "admin";
    await pagina();
    expect(screen.getByRole("button", { name: "Borrar logs" })).toBeTruthy();
    cleanup();
    rol.value = "tecnico";
    await pagina();
    expect(screen.queryByRole("button", { name: "Borrar logs" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actualizar logs" })).toBeTruthy();
  });
});
