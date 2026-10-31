import { describe, expect, test } from "bun:test";
import { FieldApi, FormApi } from "@tanstack/react-form";

import { signInFormValidators } from "./auth-form-validation";

describe("authentication form validation", () => {
  test("clears an invalid blurred field as soon as its value becomes valid", () => {
    const form = new FormApi({
      defaultValues: { email: "", password: "" },
      validators: signInFormValidators,
    });
    const email = new FieldApi({ form, name: "email" });
    const password = new FieldApi({ form, name: "password" });
    form.mount();
    email.mount();
    password.mount();

    email.handleChange("invalid");
    email.handleBlur();
    expect(email.state.meta.errors).toHaveLength(1);

    email.handleChange("valid@example.com");
    expect(email.state.meta.errors).toEqual([]);

    password.handleChange("password");
    expect(form.state.canSubmit).toBe(true);
  });

  test("still validates and touches every field on submit", async () => {
    let submitted = false;
    const form = new FormApi({
      defaultValues: { email: "", password: "" },
      validators: signInFormValidators,
      onSubmit: () => {
        submitted = true;
      },
    });
    const email = new FieldApi({ form, name: "email" });
    const password = new FieldApi({ form, name: "password" });
    form.mount();
    email.mount();
    password.mount();

    await form.handleSubmit();

    expect(submitted).toBe(false);
    expect(email.state.meta.isTouched).toBe(true);
    expect(password.state.meta.isTouched).toBe(true);
    expect(email.state.meta.errors).toHaveLength(1);
    expect(password.state.meta.errors).toHaveLength(1);
  });
});
