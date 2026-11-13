import { describe, expect, it } from "vitest";
import { isSealer, type Sealer, sealerFor } from "./secrets";

const KEY = Buffer.alloc(32, 7).toString("base64");

async function sealer(scope: string, key = KEY): Promise<Sealer> {
	const made = await sealerFor({ SECRETS_KEY: key }, scope);
	if (!isSealer(made)) throw new Error(made.unavailable);
	return made;
}

describe("sealerFor", () => {
	it("opens what it sealed, and the sealed value doesn't hold the secret", async () => {
		const workspace = await sealer("workspace-1");
		const sealed = await workspace.seal("connection/token", "cf_secret_value");
		expect(sealed).toMatch(/^v2\.[A-Za-z0-9_-]{11}\./);
		expect(sealed).not.toContain("cf_secret_value");
		expect(await workspace.open("connection/token", sealed)).toBe("cf_secret_value");
	});

	it("doesn't open another workspace's value, or one moved to another place", async () => {
		const sealed = await (await sealer("workspace-1")).seal("connection/token", "cf_x");
		await expect((await sealer("workspace-2")).open("connection/token", sealed)).rejects.toThrow(
			"A secret could not be opened",
		);
		await expect((await sealer("workspace-1")).open("connection/other", sealed)).rejects.toThrow(
			"A secret could not be opened",
		);
	});

	it("doesn't open a value under another SECRETS_KEY", async () => {
		const sealed = await (await sealer("workspace-1")).seal("connection/token", "cf_x");
		const other = await sealer("workspace-1", Buffer.alloc(32, 8).toString("base64"));
		await expect(other.open("connection/token", sealed)).rejects.toThrow();
	});

	describe("after SECRETS_KEY changes", () => {
		const NEW = Buffer.alloc(32, 9).toString("base64");
		const rotated = async (scope: string) => {
			const made = await sealerFor({ SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: KEY }, scope);
			if (!isSealer(made)) throw new Error(made.unavailable);
			return made;
		};

		it("opens values under the previous key, and seals new ones under the current", async () => {
			const old = await (await sealer("w")).seal("connection/token", "cf_old");
			const both = await rotated("w");
			expect(await both.open("connection/token", old)).toBe("cf_old");
			const again = await both.seal("connection/token", "cf_old");
			// Each names its key, which the daily run goes by.
			const newId = (await (await sealer("w", NEW)).seal("p", "x")).split(".")[1];
			expect(again.split(".")[1]).toBe(newId);
			expect(old.split(".")[1]).not.toBe(newId);
			// Once the previous key is gone, what it sealed doesn't open, and what was sealed again does.
			const only = await sealer("w", NEW);
			await expect(only.open("connection/token", old)).rejects.toThrow(
				"A secret could not be opened",
			);
			expect(await only.open("connection/token", again)).toBe("cf_old");
		});

		it("opens a value from before keys had ids under either key", async () => {
			const sealed = await (await sealer("w")).seal("connection/token", "cf_v1");
			const [, , iv, data] = sealed.split(".");
			const v1 = `v1.${iv}.${data}`;
			expect(await (await sealer("w")).open("connection/token", v1)).toBe("cf_v1");
			expect(await (await rotated("w")).open("connection/token", v1)).toBe("cf_v1");
			await expect((await sealer("w", NEW)).open("connection/token", v1)).rejects.toThrow(
				"A secret could not be opened",
			);
		});

		it("doesn't open a value that names a key it doesn't have, whatever it holds", async () => {
			const sealed = await (await sealer("w")).seal("connection/token", "cf_x");
			const [, , iv, data] = sealed.split(".");
			const unknown = `v2.AAAAAAAAAAA.${iv}.${data}`;
			await expect((await rotated("w")).open("connection/token", unknown)).rejects.toThrow(
				"A secret could not be opened",
			);
			// Nor under the key that sealed it, when the value names another.
			await expect((await sealer("w")).open("connection/token", unknown)).rejects.toThrow(
				"A secret could not be opened",
			);
		});

		it("refuses a value whose shape it doesn't know", async () => {
			const both = await rotated("w");
			for (const odd of ["v2..AAAA.AAAA", "v3.a.b.c", "v1.a", "v2.a.b"]) {
				await expect(both.open("connection/token", odd)).rejects.toThrow("Not a sealed secret");
			}
		});
	});

	it("says why it can't keep secrets without a key long enough", async () => {
		expect(await sealerFor({}, "w")).toEqual({
			unavailable: expect.stringContaining("SECRETS_KEY"),
		});
		expect(await sealerFor({ SECRETS_KEY: Buffer.alloc(16).toString("base64") }, "w")).toEqual({
			unavailable: expect.stringContaining("32 bytes"),
		});
		expect(await sealerFor({ SECRETS_KEY: "not base64!" }, "w")).toEqual({
			unavailable: expect.stringContaining("SECRETS_KEY"),
		});
	});
});
