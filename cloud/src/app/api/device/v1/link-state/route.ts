import { authenticateDevice } from "@/lib/device/auth";
import { deviceJson, deviceRoute } from "@/lib/device/http";

/** GET /api/device/v1/link-state (Device): estado de vinculación del panel. */
export async function GET(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateDevice(req);
    return deviceJson({ status: panel.status });
  });
}
