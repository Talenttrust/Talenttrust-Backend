import { switchToGreen, rollback, getStatus } from "./deploy";
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

describe("Deployment Manager", () => {
  beforeEach(async () => {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  });

  it("initial state is blue", async () => {
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
  });

  it("switch to green updates state", async () => {
    await switchToGreen();
    const status = await getStatus();
    expect(status.activeColor).toBe("green");
    expect(status.previousColor).toBe("blue");
  });

  it("rollback restores previous", async () => {
    await switchToGreen();
    await rollback();
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
  });

  it("switch to green already green no-op", async () => {
    await switchToGreen();
    const before = await getStatus();
    await switchToGreen();
    const after = await getStatus();
    expect(after.lastSwitch).toBe(before.lastSwitch);
  });
});
