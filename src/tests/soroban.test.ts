import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { getContractMethods } from "../soroban/contractMetadata";
import { prepareContractCall } from "../soroban/prepareCall";
import { readContract } from "../soroban/readContract";
import { SorokitErrorCode } from "../shared/response";
import type { SorokitCache } from "../shared/cache";

const rpcMock = vi.hoisted(() => ({
  getLedgerEntries: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => rpcMock),
    },
  };
});

class MemoryCache implements SorokitCache {
  values = new Map<string, unknown>();
  ttlMs: number | undefined;

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.values.set(key, value);
    this.ttlMs = ttlMs;
  }

  invalidate(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function contractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

function encodeLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;

  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);

  return bytes;
}

function contractSpecWasm(entries: xdr.ScSpecEntry[]): Buffer {
  const name = Buffer.from("contractspecv0");
  const spec = Buffer.concat(entries.map((entry) => entry.toXDR()));
  const sectionSize = name.length + encodeLeb128(name.length).length + spec.length;

  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...encodeLeb128(sectionSize),
    ...encodeLeb128(name.length),
    ...name,
    ...spec,
  ]);
}

function methodSpec(): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: "",
      name: "hello",
      inputs: [
        new xdr.ScSpecFunctionInputV0({
          doc: "",
          name: "to",
          type: xdr.ScSpecTypeDef.scSpecTypeSymbol(),
        }),
      ],
      outputs: [xdr.ScSpecTypeDef.scSpecTypeString()],
    }),
  );
}

function mockContractLedgerEntries(wasm: Buffer): void {
  rpcMock.getLedgerEntries
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractData: () => ({
              val: () => ({
              instance: () => ({
                executable: () =>
                  xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
              }),
            }),
          }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractCode: () => ({
              code: () => wasm,
            }),
          },
        },
      ],
    });
}

function mockStellarAssetContractEntry(): void {
  rpcMock.getLedgerEntries.mockResolvedValueOnce({
    entries: [
      {
        val: {
          contractData: () => ({
            val: () => ({
              instance: () => ({
                executable: () => xdr.ContractExecutable.contractExecutableStellarAsset(),
              }),
            }),
          }),
        },
      },
    ],
  });
}

describe("soroban contract metadata", () => {
  beforeEach(() => {
    rpcMock.getLedgerEntries.mockReset();
  });

  it("discovers contract methods from Soroban contract spec metadata", async () => {
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const result = await getContractMethods("https://rpc.example.com", contractId());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual([
        {
          name: "hello",
          inputs: [{ name: "to", type: "symbol" }],
          returnType: "string",
        },
      ]);
    }
  });

  it("caches discovered methods with the default one-hour TTL", async () => {
    const cache = new MemoryCache();
    const id = contractId();
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const first = await getContractMethods("https://rpc-cache.example.com", id, {
      cache,
      now: () => 1_000,
    });
    const second = await getContractMethods("https://rpc-cache.example.com", id, {
      cache,
      now: () => 2_000,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(rpcMock.getLedgerEntries).toHaveBeenCalledTimes(2);
    expect(cache.ttlMs).toBe(60 * 60 * 1000);
  });

  it("misses the cache after TTL expiry and refetches metadata", async () => {
    const id = contractId();
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));
    mockContractLedgerEntries(contractSpecWasm([methodSpec()]));

    const first = await getContractMethods("https://rpc-expiry.example.com", id, {
      ttlMs: 10,
      now: () => 1_000,
    });
    const second = await getContractMethods("https://rpc-expiry.example.com", id, {
      ttlMs: 10,
      now: () => 1_011,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(rpcMock.getLedgerEntries).toHaveBeenCalledTimes(4);
  });

  it("returns a typed error when the contract is not Wasm-backed", async () => {
    mockStellarAssetContractEntry();

    const result = await getContractMethods("https://rpc-sac.example.com", contractId());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
      expect(result.error.message).toContain("requires a Wasm contract");
    }
    expect(rpcMock.getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it("validates cached metadata before preparing a contract call", async () => {
    const result = await prepareContractCall(
      "https://rpc.example.com",
      {
        network: "testnet",
        horizonUrl: "https://horizon.example.com",
        rpcUrl: "https://rpc.example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
      },
      "https://horizon.example.com",
      {
        contractId: contractId(),
        method: "missing",
        publicKey: Keypair.random().publicKey(),
        cachedMetadata: [
          {
            name: "hello",
            inputs: [],
            returnType: null,
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_PREPARE_FAILED);
    }
  });

  it("validates cached metadata before reading a contract", async () => {
    const result = await readContract(
      "https://rpc.example.com",
      "https://horizon.example.com",
      {
        network: "testnet",
        horizonUrl: "https://horizon.example.com",
        rpcUrl: "https://rpc.example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
      },
      {
        contractId: contractId(),
        method: "hello",
        publicKey: Keypair.random().publicKey(),
        cachedMetadata: [
          {
            name: "hello",
            inputs: [{ name: "to", type: "symbol" }],
            returnType: "string",
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.CONTRACT_READ_FAILED);
      expect(result.error.message).toContain("expects 1 argument");
    }
  });
});
