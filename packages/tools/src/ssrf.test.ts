/**
 * Unit tests for the SSRF-aware outbound-URL validator — one negative case
 * per rule code plus the pass-throughs, mirroring the legacy Python
 * implementation's suite.
 *
 * NO REAL NETWORK: every test injects a fake `resolveHost`, so DNS behavior
 * (public, private, NXDOMAIN, v4-mapped v6) is fully deterministic.
 *
 * The AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS env var is cleared before every
 * test and restored after the suite, so the escape-hatch cases cannot leak
 * into the strict-mode cases (or into other suites).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  SourceUrlValidationError,
  isPrivateIp,
  validateSourceUrl,
  type ValidateSourceUrlOptions,
} from "./ssrf.js";

const LOCALHOST_ENV = "AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS";
const originalEnv = process.env[LOCALHOST_ENV];

beforeEach(() => {
  delete process.env[LOCALHOST_ENV];
});

afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env[LOCALHOST_ENV];
  } else {
    process.env[LOCALHOST_ENV] = originalEnv;
  }
});

/** Stub resolver: every hostname resolves to a well-known public IP. */
const publicDns: ValidateSourceUrlOptions = {
  resolveHost: async () => ["8.8.8.8"],
};

function resolvingTo(...ips: string[]): ValidateSourceUrlOptions {
  return { resolveHost: async () => ips };
}

/** Assert rejection, assert the error type, and hand back the typed error. */
async function expectRejection(
  url: string,
  opts?: ValidateSourceUrlOptions,
): Promise<SourceUrlValidationError> {
  try {
    await validateSourceUrl(url, opts);
  } catch (err) {
    expect(err).toBeInstanceOf(SourceUrlValidationError);
    return err as SourceUrlValidationError;
  }
  throw new Error(`expected ${JSON.stringify(url)} to be rejected`);
}

describe("rule 1 — https-only scheme", () => {
  it("accepts a plain https URL", async () => {
    await validateSourceUrl("https://www.hyundaiusa.com/offers", publicDns);
  });

  it("rejects http", async () => {
    const err = await expectRejection(
      "http://www.hyundaiusa.com/offers",
      publicDns,
    );
    expect(err.code).toBe("non_https");
  });

  it("rejects ftp", async () => {
    const err = await expectRejection("ftp://example.com/offers", publicDns);
    expect(err.code).toBe("non_https");
  });
});

describe("rule 2 — no credentials in URL", () => {
  it("rejects user:pass userinfo", async () => {
    const err = await expectRejection(
      "https://user:pass@www.example.com/offers",
      publicDns,
    );
    expect(err.code).toBe("credentials_in_url");
  });

  it("rejects a bare username", async () => {
    const err = await expectRejection(
      "https://admin@www.example.com/offers",
      publicDns,
    );
    expect(err.code).toBe("credentials_in_url");
  });
});

describe("rules 3+4 — path traversal", () => {
  it("rejects a raw '..' segment", async () => {
    const err = await expectRejection(
      "https://www.example.com/offers/../etc",
      publicDns,
    );
    expect(err.code).toBe("path_traversal");
  });

  it("rejects a percent-encoded '..' segment", async () => {
    const err = await expectRejection(
      "https://www.example.com/offers/%2e%2e/etc",
      publicDns,
    );
    expect(err.code).toBe("path_traversal");
  });

  it("rejects '..' behind a percent-encoded slash", async () => {
    const err = await expectRejection(
      "https://www.example.com/offers%2F..%2Fetc",
      publicDns,
    );
    expect(err.code).toBe("path_traversal");
  });

  it("does NOT double-decode (%252e stays '%2e')", async () => {
    await validateSourceUrl(
      "https://www.example.com/offers/%252e%252e/etc",
      publicDns,
    );
  });
});

describe("rule 5 — shell metacharacters", () => {
  it.each([";", "&", "|", "`", "$", "(", ")", "<", ">"])(
    "rejects %j in the path",
    async (ch) => {
      const err = await expectRejection(
        `https://www.example.com/offers/file${ch}name`,
        publicDns,
      );
      expect(err.code).toBe("shell_metacharacter");
    },
  );

  it("rejects a percent-encoded metacharacter (%3B → ';')", async () => {
    const err = await expectRejection(
      "https://www.example.com/offers%3Bcurl-evil",
      publicDns,
    );
    expect(err.code).toBe("shell_metacharacter");
  });

  it("rejects metacharacters in the query too", async () => {
    const err = await expectRejection(
      "https://www.example.com/offers?x=1|2",
      publicDns,
    );
    expect(err.code).toBe("shell_metacharacter");
  });

  it("allows {model}/{zip} template placeholders (braces are not metas)", async () => {
    await validateSourceUrl(
      "https://www.hyundaiusa.com/{model}/{zip}/offers",
      publicDns,
    );
  });
});

describe("rule 6 — IP-literal host", () => {
  it("rejects an IPv4 literal without consulting DNS", async () => {
    let resolverCalled = false;
    const err = await expectRejection("https://192.0.2.1/offers", {
      resolveHost: async () => {
        resolverCalled = true;
        return ["8.8.8.8"];
      },
    });
    expect(err.code).toBe("ip_literal_host");
    expect(resolverCalled).toBe(false);
  });

  it("rejects a bracketed IPv6 literal", async () => {
    const err = await expectRejection("https://[2001:db8::1]/offers", publicDns);
    expect(err.code).toBe("ip_literal_host");
  });
});

describe("rule 7 — private IP resolution (fail-closed DNS)", () => {
  it("rejects a host resolving to RFC1918 space", async () => {
    const err = await expectRejection(
      "https://attacker.example.com/offers",
      resolvingTo("192.168.1.1"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects a host resolving to link-local (cloud metadata)", async () => {
    const err = await expectRejection(
      "https://meta.example.com/offers",
      resolvingTo("169.254.169.254"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects a host resolving to CGNAT 100.64/10", async () => {
    const err = await expectRejection(
      "https://cg.example.com/offers",
      resolvingTo("100.64.0.1"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects when ANY of several addresses is private", async () => {
    const err = await expectRejection(
      "https://multi.example.com/offers",
      resolvingTo("8.8.8.8", "10.0.0.1"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects on NXDOMAIN / resolver failure (fail closed)", async () => {
    const err = await expectRejection("https://no-such-host.invalid/offers", {
      resolveHost: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        });
      },
    });
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects an empty resolution result (fail closed)", async () => {
    const err = await expectRejection(
      "https://empty.example.com/offers",
      resolvingTo(),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("rejects a v4-mapped IPv6 answer wrapping a private IPv4", async () => {
    const err = await expectRejection(
      "https://mapped.example.com/offers",
      resolvingTo("::ffff:192.168.1.1"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });

  it("accepts a v4-mapped IPv6 answer wrapping a public IPv4", async () => {
    await validateSourceUrl(
      "https://mapped-ok.example.com/offers",
      resolvingTo("::ffff:8.8.8.8"),
    );
  });

  it("accepts a public IPv6 answer", async () => {
    await validateSourceUrl(
      "https://v6.example.com/offers",
      resolvingTo("2606:4700:4700::1111"),
    );
  });

  it("rejects an unparseable resolver answer (fail closed)", async () => {
    const err = await expectRejection(
      "https://weird.example.com/offers",
      resolvingTo("not-an-ip"),
    );
    expect(err.code).toBe("private_ip_resolution");
  });
});

describe("rule 8 — IDNA validity + homograph defence", () => {
  it("rejects an invisible codepoint (zero-width space) in the host", async () => {
    const err = await expectRejection(
      "https://exa\u200Bmple.com/offers",
      publicDns,
    );
    expect(err.code).toBe("idna_invalid");
  });

  it("rejects a mixed-script homograph label (Cyrillic 'а' in 'pаypal')", async () => {
    // "pаypal" — Latin letters around one Cyrillic "а" (U+0430).
    const err = await expectRejection(
      "https://p\u0430ypal.com/offers",
      publicDns,
    );
    expect(err.code).toBe("idna_invalid");
    expect(err.message.toLowerCase()).toMatch(/homograph|mix/);
  });

  it("accepts a clean single-script IDN host", async () => {
    await validateSourceUrl("https://münchen.example/offers", publicDns);
  });

  it("accepts different scripts in DIFFERENT labels", async () => {
    // Mixing across labels is normal (e.g. a Cyrillic brand label under an
    // ASCII TLD); only mixing INSIDE one label is a homograph signal.
    await validateSourceUrl(
      "https://пример.example.com/offers",
      publicDns,
    );
  });
});

describe("rule 9 — URL length", () => {
  it("rejects a URL over 2048 utf-8 bytes", async () => {
    const err = await expectRejection(
      `https://www.example.com/${"a".repeat(2100)}`,
      publicDns,
    );
    expect(err.code).toBe("url_too_long");
  });

  it("accepts a URL of exactly 2048 bytes", async () => {
    const base = "https://www.example.com/";
    await validateSourceUrl(base + "a".repeat(2048 - base.length), publicDns);
  });

  it("counts utf-8 BYTES, not string length", async () => {
    // 1200 two-byte chars -> 2424 bytes although the string is only ~1224
    // chars long.
    const err = await expectRejection(
      `https://www.example.com/${"é".repeat(1200)}`,
      publicDns,
    );
    expect(err.code).toBe("url_too_long");
  });
});

describe("localhost test escape hatch", () => {
  it("accepts http://127.0.0.1 and http://localhost with the env set", async () => {
    process.env[LOCALHOST_ENV] = "1";
    await validateSourceUrl("http://127.0.0.1:8765/offers", publicDns);
    await validateSourceUrl("http://localhost:8765/offers", publicDns);
  });

  it("accepts the https://127.0.0.1 IP literal with the env set", async () => {
    process.env[LOCALHOST_ENV] = "1";
    await validateSourceUrl("https://127.0.0.1:8765/offers", publicDns);
  });

  it("rejects http://127.0.0.1 without the env", async () => {
    const err = await expectRejection("http://127.0.0.1:8765/offers", publicDns);
    expect(err.code).toBe("non_https");
  });

  it("rejects the https://127.0.0.1 IP literal without the env", async () => {
    const err = await expectRejection(
      "https://127.0.0.1:8765/offers",
      publicDns,
    );
    expect(err.code).toBe("ip_literal_host");
  });

  it("still rejects NON-localhost IP literals with the env set", async () => {
    process.env[LOCALHOST_ENV] = "1";
    const err = await expectRejection("https://192.168.1.1/offers", publicDns);
    expect(err.code).toBe("ip_literal_host");
  });
});

describe("empty / malformed input (fail closed)", () => {
  it("rejects an empty URL", async () => {
    const err = await expectRejection("", publicDns);
    expect(err.code).toBe("non_https");
  });

  it("rejects a scheme-less string", async () => {
    const err = await expectRejection("not a url", publicDns);
    expect(err.code).toBe("non_https");
  });

  it("rejects a hostname-less URL", async () => {
    const err = await expectRejection("https:///offers", publicDns);
    expect(err.code).toBe("non_https");
  });
});

describe("error shape", () => {
  it("carries code, field='url', and a stable name", async () => {
    const err = await expectRejection("http://example.com/", publicDns);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SourceUrlValidationError");
    expect(err.field).toBe("url");
    expect(err.code).toBe("non_https");
  });
});

describe("isPrivateIp", () => {
  it.each([
    // public IPv4
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["100.63.255.255", false], // just below CGNAT
    ["100.128.0.0", false], // just above CGNAT
    ["172.15.255.255", false], // just below 172.16/12
    ["172.32.0.1", false], // just above 172.16/12
    ["192.0.3.1", false], // just outside TEST-NET-1
    // private / special IPv4
    ["0.0.0.0", true],
    ["10.0.0.1", true],
    ["100.64.0.1", true], // CGNAT
    ["100.127.255.255", true],
    ["127.0.0.1", true], // loopback
    ["169.254.169.254", true], // link-local
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.0.0.1", true],
    ["192.0.2.1", true], // TEST-NET-1
    ["192.168.1.1", true],
    ["198.18.0.1", true], // benchmarking
    ["198.51.100.9", true], // TEST-NET-2
    ["203.0.113.9", true], // TEST-NET-3
    ["224.0.0.1", true], // multicast
    ["240.0.0.1", true], // reserved
    ["255.255.255.255", true], // broadcast
    // public IPv6
    ["2606:4700:4700::1111", false],
    ["2a00:1450:4001:800::200e", false],
    ["2001:500::1", false], // inside 2001::/16 but outside the /23 carve-out
    ["2606:4700:4700:0:0:0:0:1111", false], // uncompressed form
    // private / special IPv6
    ["::", true], // unspecified
    ["::1", true], // loopback
    ["fe80::1", true], // link-local
    ["fc00::1", true], // unique-local
    ["fd12:3456:789a::1", true], // unique-local
    ["ff02::1", true], // multicast
    ["100::1", true], // discard-only
    ["64:ff9b::8.8.8.8", true], // NAT64 prefix, outside 2000::/3
    ["2001::1", true], // TEREDO / protocol assignments
    ["2001:db8::1", true], // documentation
    // v4-mapped IPv6 classifies as the embedded IPv4
    ["::ffff:192.168.1.1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    // unparseable — fail closed
    ["", true],
    ["not-an-ip", true],
    ["1.2.3", true],
    ["1.2.3.4.5", true],
    ["999.0.0.1", true],
    ["01.2.3.4", true], // leading zero (octal ambiguity)
    ["1:2:3:4:5:6:7", true], // seven groups
    ["1::2::3", true], // two "::"
    ["fe80::1%eth0", true], // zone suffix unsupported
  ])("isPrivateIp(%j) === %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});
