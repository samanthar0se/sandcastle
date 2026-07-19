import { describe, expect, it } from "vitest";
import { listAgents, getAgent } from "./InitService.js";

describe("Agent registry", () => {
  it("listAgents returns at least claude-code", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "claude-code")).toBe(true);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-8");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgents includes pi", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "pi")).toBe(true);
  });

  it("getAgent returns pi entry with expected fields", () => {
    const agent = getAgent("pi");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("pi");
    expect(agent!.defaultModel).toBe("openai-codex/gpt-5.6-sol");
    expect(agent!.factoryImport).toBe("pi");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain(
      "@earendil-works/pi-coding-agent@0.80.10",
    );
    expect(agent!.dockerfileTemplate).toContain(
      "@howaboua/pi-codex-conversion@2.2.13",
    );
  });

  it("listAgents includes codex", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "codex")).toBe(true);
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe("gpt-5.4");
    expect(agent!.factoryImport).toBe("codex");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@openai/codex");
  });

  it("listAgents includes opencode", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "opencode")).toBe(true);
  });

  it("listAgents includes cursor", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "cursor")).toBe(true);
  });

  it("getAgent returns cursor entry with expected fields", () => {
    const agent = getAgent("cursor");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("cursor");
    expect(agent!.defaultModel).toBe("composer-2");
    expect(agent!.factoryImport).toBe("cursor");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("cursor.com/install");
  });

  it("getAgent returns opencode entry with expected fields", () => {
    const agent = getAgent("opencode");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("opencode");
    expect(agent!.defaultModel).toBe("opencode/big-pickle");
    expect(agent!.factoryImport).toBe("opencode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("opencode-ai");
  });

  it("listAgents includes copilot", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "copilot")).toBe(true);
  });

  it("getAgent returns copilot entry with expected fields", () => {
    const agent = getAgent("copilot");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("copilot");
    expect(agent!.factoryImport).toBe("copilot");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@github/copilot");
  });
});
