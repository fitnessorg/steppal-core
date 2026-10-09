import { describe, it, expect } from "vitest";
import { normalisePhone } from "../src/lib/phone.js";

describe("normalisePhone", () => {
  it("accepts the five ways Nigerians write one number", () => {
    for (const input of [
      "08031234567",
      "0803 123 4567",
      "234-803-123-4567",
      "+2348031234567",
      "+234 803 123 4567",
    ]) {
      expect(normalisePhone(input)).toBe("+2348031234567");
    }
  });

  it("keeps other countries in E.164 so testers abroad can sign in", () => {
    expect(normalisePhone("+14155552671")).toBe("+14155552671");
  });

  it("rejects what is not a phone number", () => {
    for (const input of ["", "12345", "hello", "080312345678901234"]) {
      expect(normalisePhone(input)).toBeNull();
    }
  });
});
