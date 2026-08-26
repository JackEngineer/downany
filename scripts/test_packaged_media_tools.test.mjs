import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  executableNames,
  inspectProbePayload,
  smokeMediaTools,
} from "./test_packaged_media_tools.mjs";

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "downany-media-tools-tests-"),
);

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function createToolDirectory(platform = "linux") {
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "bin-"));
  const names = executableNames(platform);
  for (const name of [names.ffmpeg, names.ffprobe]) {
    const executable = path.join(directory, name);
    fs.writeFileSync(executable, "fixture");
    fs.chmodSync(executable, 0o755);
  }
  return { directory, names };
}

function successfulRunner(calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (args[0] === "-version") {
      return { status: 0, stdout: `${path.basename(command)} version fixture\n`, stderr: "" };
    }
    if (path.basename(command).toLowerCase().startsWith("ffmpeg")) {
      fs.writeFileSync(args.at(-1), "generated-media");
      return { status: 0, stdout: "", stderr: "" };
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams: [{ codec_type: "video" }, { codec_type: "audio" }],
        chapters: [],
      }),
      stderr: "",
    };
  };
}

test("uses platform-specific executable names", () => {
  assert.deepEqual(executableNames("win32"), {
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
  });
  assert.deepEqual(executableNames("darwin"), {
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
  });
  assert.deepEqual(executableNames("linux"), {
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
  });
});

test("requires video, audio, and a recognized container", () => {
  assert.equal(
    inspectProbePayload({
      format: { format_name: "mp4" },
      streams: [{ codec_type: "audio" }],
    }).ok,
    false,
  );
  assert.equal(
    inspectProbePayload({
      format: { format_name: "mp4" },
      streams: [{ codec_type: "video" }],
    }).ok,
    false,
  );
  assert.equal(
    inspectProbePayload({
      format: { format_name: "unknown-fixture" },
      streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    }).ok,
    false,
  );
});

test("rejects a directory missing either member of the pair", () => {
  for (const missing of ["ffmpeg", "ffprobe"]) {
    const directory = fs.mkdtempSync(path.join(fixtureRoot, `missing-${missing}-`));
    const names = executableNames("win32");
    const retained = missing === "ffmpeg" ? names.ffprobe : names.ffmpeg;
    fs.writeFileSync(path.join(directory, retained), "fixture");

    const result = smokeMediaTools({
      binDir: directory,
      platform: "win32",
      run: () => {
        throw new Error("runner must not be called for an incomplete pair");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.productMessage, new RegExp(missing, "i"));
  }
});

test("rejects a non-zero version probe", () => {
  const { directory } = createToolDirectory("win32");
  const result = smokeMediaTools({
    binDir: directory,
    platform: "win32",
    run: (command, args) => ({
      status:
        path.basename(command).toLowerCase() === "ffprobe.exe" &&
        args[0] === "-version"
          ? 7
          : 0,
      stdout: "",
      stderr: "version probe failed",
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.productMessage, /ffprobe.*version/i);
});

test("rejects malformed ffprobe JSON and removes its temporary directory", () => {
  const { directory } = createToolDirectory("darwin");
  let generatedPath = "";
  const result = smokeMediaTools({
    binDir: directory,
    platform: "darwin",
    run: (command, args) => {
      if (args[0] === "-version") return { status: 0, stdout: "version", stderr: "" };
      if (path.basename(command) === "ffmpeg") {
        generatedPath = args.at(-1);
        fs.writeFileSync(generatedPath, "generated-media");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "{broken-json", stderr: "" };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.productMessage, /ffprobe.*JSON/i);
  assert.ok(generatedPath);
  assert.equal(fs.existsSync(path.dirname(generatedPath)), false);
});

test("generates and probes a deterministic video and audio sample", () => {
  const { directory } = createToolDirectory("win32");
  const calls = [];
  const result = smokeMediaTools({
    binDir: directory,
    platform: "win32",
    run: successfulRunner(calls),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args, ["-version"]);
  assert.deepEqual(calls[1].args, ["-version"]);
  assert.deepEqual(calls[2].args.slice(0, -1), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=size=160x90:rate=10:duration=0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=0.5",
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-shortest",
  ]);
  assert.deepEqual(calls[3].args.slice(0, -1), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
  ]);
  assert.ok(calls.every((call) => call.options.timeout === 15_000));
  assert.ok(calls.every((call) => call.options.maxBuffer === 1024 * 1024));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.equal(fs.existsSync(path.dirname(calls[2].args.at(-1))), false);
});
