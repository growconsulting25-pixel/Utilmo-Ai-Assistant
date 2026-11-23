import { describe, expect, it } from "vitest";
import { detectLanguage, extractContact, normalizeEmail, normalizePhone } from "../../packages/ai-core/src/extraction";

describe("contact extraction", () => {
  it("normalises Canadian phone numbers to E.164", () => {
    expect(normalizePhone("514-555-0123")).toBe("+15145550123");
    expect(normalizePhone("(450) 555-0199")).toBe("+14505550199");
    expect(normalizePhone("+1 514 555 0123")).toBe("+15145550123");
  });
  it("accepts international numbers and rejects invalid ones", () => {
    expect(normalizePhone("+33 1 42 68 53 00")).toBe("+33142685300");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("555-0000")).toBeNull();
  });
  it("validates e-mail format", () => {
    expect(normalizeEmail("Jean.Tremblay@Example.CA")).toBe("jean.tremblay@example.ca");
    expect(normalizeEmail("bad@@example")).toBeNull();
    expect(normalizeEmail("a..b@example.com")).toBeNull();
  });
  it("extracts all contact details from one message (scenario 11)", () => {
    const u = extractContact("Je m'appelle Jean Tremblay, 514-555-0123, jean.tremblay@example.com");
    expect(u.first_name?.value).toBe("Jean");
    expect(u.last_name?.value).toBe("Tremblay");
    expect(u.phone?.value).toBe("+15145550123");
    expect(u.email?.value).toBe("jean.tremblay@example.com");
  });
  it("does not read e-mail digits as phone numbers", () => {
    expect(extractContact("contact: agent5145550123@example.com").phone).toBeUndefined();
  });
  it("detects French vs English", () => {
    expect(detectLanguage("J'aimerais savoir si vous pouvez m'aider à obtenir plus de vendeurs")).toBe("fr");
    expect(detectLanguage("I would like more seller leads for my business")).toBe("en");
  });
});
