describe("resend", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("resend tag encoding", () => {
    describe("when a value already satisfies Resend's charset", () => {
      it("should pass it through unchanged", async () => {
        const { encodeResendTagValue } = await import("./resend");

        // UUID-shaped tags travel over the wire untouched, which is what lets
        // webhooksController read tags.workspaceId without decoding first.
        const workspaceId = "08283241-919f-46f8-92b4-379a7fcd1ced";
        expect(encodeResendTagValue(workspaceId)).toBe(workspaceId);
        expect(encodeResendTagValue("user_123")).toBe("user_123");
        expect(encodeResendTagValue("plain")).toBe("plain");
      });
    });

    describe("when a value falls outside Resend's charset", () => {
      it("should encode it into the permitted charset and round trip", async () => {
        const { encodeResendTagValue, decodeResendTagValue } = await import(
          "./resend"
        );

        const userId = "someone@example.com";
        const encoded = encodeResendTagValue(userId);

        expect(encoded).not.toBe(userId);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeResendTagValue(encoded)).toBe(userId);
      });

      it("should round trip non-ascii values", async () => {
        const { encodeResendTagValue, decodeResendTagValue } = await import(
          "./resend"
        );

        const userId = "dragón+tag@example.com";
        const encoded = encodeResendTagValue(userId);

        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeResendTagValue(encoded)).toBe(userId);
      });
    });

    describe("when a safe value collides with the sentinel prefix", () => {
      it("should still round trip", async () => {
        const { encodeResendTagValue, decodeResendTagValue } = await import(
          "./resend"
        );

        const userId = "dfb64-not-actually-encoded";
        const encoded = encodeResendTagValue(userId);

        expect(encoded).not.toBe(userId);
        expect(decodeResendTagValue(encoded)).toBe(userId);
      });
    });

    describe("encodeResendTags", () => {
      it("should encode only the values that need it", async () => {
        const { encodeResendTags } = await import("./resend");

        expect(
          encodeResendTags({
            workspaceId: "08283241-919f-46f8-92b4-379a7fcd1ced",
            messageId: "3f2d1c4b-8a90-4d1e-9f77-1b2c3d4e5f60",
            userId: "someone@example.com",
          }),
        ).toEqual([
          {
            name: "workspaceId",
            value: "08283241-919f-46f8-92b4-379a7fcd1ced",
          },
          {
            name: "messageId",
            value: "3f2d1c4b-8a90-4d1e-9f77-1b2c3d4e5f60",
          },
          { name: "userId", value: "dfb64-c29tZW9uZUBleGFtcGxlLmNvbQ" },
        ]);
      });

      it("should drop a tag whose encoded value exceeds the length limit", async () => {
        const { encodeResendTags } = await import("./resend");

        const tags = encodeResendTags({
          workspaceId: "08283241-919f-46f8-92b4-379a7fcd1ced",
          userId: `${"a".repeat(300)}@example.com`,
        });

        expect(tags.map((t) => t.name)).toEqual(["workspaceId"]);
      });
    });

    describe("resendEventToDF", () => {
      it("should decode the userId back to the value that was sent", async () => {
        const { resendEventToDF } = await import("./resend");
        const { ResendEventType } = await import("../types");

        const workspaceId = "08283241-919f-46f8-92b4-379a7fcd1ced";
        const result = resendEventToDF({
          workspaceId,
          resendEvent: {
            type: ResendEventType.Opened,
            created_at: "2026-08-23T00:00:00.000Z",
            data: {
              created_at: "2026-08-23T00:00:00.000Z",
              email_id: "email_123",
              from: "sender@example.com",
              subject: "Test Subject",
              to: ["someone@example.com"],
              tags: {
                workspaceId,
                userId: "dfb64-c29tZW9uZUBleGFtcGxlLmNvbQ",
              },
            },
          },
        });

        expect(result.isOk()).toBe(true);
        result.match(
          (item) => {
            expect(item).toMatchObject({
              userId: "someone@example.com",
              properties: {
                email: "someone@example.com",
                workspaceId,
                userId: "someone@example.com",
              },
            });
          },
          () => fail("Expected ok result"),
        );
      });
    });
  });
});
