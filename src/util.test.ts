import { describe, expect, it } from "bun:test";
import { run, runStream, sleep } from "./util";

describe("sleep", () => {
  it("resuelve pasados al menos los milisegundos indicados", async () => {
    const t0 = Date.now();
    await sleep(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });
});

describe("run", () => {
  it("captura stdout con code 0", async () => {
    const r = await run(["sh", "-c", "echo hello"], { capture: true });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("captura stderr y el código de salida no nulo", async () => {
    const r = await run(["sh", "-c", "echo boom 1>&2; exit 3"], {
      capture: true,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  it("devuelve -1 si el comando no existe", async () => {
    const r = await run(["comando-que-no-existe-xyz"], { capture: true });
    expect(r.code).toBe(-1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("funciona sin captura (stdio inherit)", async () => {
    const r = await run(["true"]);
    expect(r.code).toBe(0);
  });
});

describe("runStream", () => {
  it("resuelve con el código de salida y emite las líneas", async () => {
    const lines: string[] = [];
    const code = await runStream(["sh", "-c", "echo uno; echo dos"], {
      onStdout: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.map((l) => l.trim())).toEqual(["uno", "dos"]);
  });

  it("emite las líneas de stderr", async () => {
    const errs: string[] = [];
    const code = await runStream(["sh", "-c", "echo error 1>&2"], {
      onStderr: (l) => errs.push(l),
    });
    expect(code).toBe(0);
    expect(errs.map((l) => l.trim())).toContain("error");
  });

  it("el controller pausa y reanuda el proceso", async () => {
    const ac = new AbortController();
    let count = 0;
    const controller = { pause() {}, resume() {} };
    const p = runStream(
      ["sh", "-c", "while :; do echo x; sleep 0.02; done"],
      { onStdout: () => count++, controller, signal: ac.signal },
    );

    await sleep(150);
    const running = count;
    expect(running).toBeGreaterThan(0);

    controller.pause();
    await sleep(150);
    const paused = count;
    // Al estar congelado no debe producir líneas nuevas.
    expect(paused).toBeLessThanOrEqual(running + 1);

    controller.resume();
    await sleep(150);
    const resumed = count;
    expect(resumed).toBeGreaterThan(paused);

    ac.abort();
    await p.catch(() => {});
  });

  it("abort() mata el proceso hijo", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runStream(["sleep", "30"], { signal: ac.signal });
    await sleep(100);
    ac.abort();
    const code = await p;
    expect(code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("devuelve -1 si el comando no existe", async () => {
    const code = await runStream(["comando-que-no-existe-xyz"]);
    expect(code).toBe(-1);
  });
});
