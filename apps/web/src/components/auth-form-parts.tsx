import { Button } from "@northwind/ui/components/button";
import { Input } from "@northwind/ui/components/input";
import { Label } from "@northwind/ui/components/label";
import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

/**
 * 登录 / 注册表单共用的展示件（sign-in-form 与 sign-up-form 各保留自己的
 * form.Field 类型接线与校验器，渲染层在这里共享一份）。
 */

export function AuthSocialDivider({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="my-6 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        or
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function AuthErrorBanner({
  id,
  message,
}: {
  id: string;
  message: string | null;
}) {
  if (!message) return null;
  return (
    <p
      id={id}
      className="mb-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
      role="alert"
    >
      {message}
    </p>
  );
}

export function focusFirstInvalidAuthField(formId: string): void {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLInputElement>(`#${formId} [aria-invalid="true"]`)
      ?.focus();
  });
}

type AuthFieldProps = {
  /** DOM id（aria-describedby 用 `${id}-error`） */
  id: string;
  /** input name（浏览器自动填充按语义命名：email / password / name） */
  name: string;
  label: string;
  value: string;
  error: string | null;
  onValueChange: (value: string) => void;
  onBlur: () => void;
  inputProps?: Omit<
    ComponentProps<typeof Input>,
    "id" | "name" | "value" | "onBlur" | "onChange" | "aria-invalid" | "aria-describedby"
  >;
};

export function AuthTextField({
  id,
  name,
  label,
  value,
  error,
  onValueChange,
  onBlur,
  inputProps,
}: AuthFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        value={value}
        onBlur={onBlur}
        onChange={(e) => onValueChange(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuthPasswordField({
  id,
  name,
  label,
  value,
  error,
  onValueChange,
  onBlur,
  autoComplete,
  labelAside,
}: AuthFieldProps & {
  autoComplete: "current-password" | "new-password";
  labelAside?: ReactNode;
}) {
  const [showPassword, setShowPassword] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {labelAside}
      </div>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={showPassword ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onBlur={onBlur}
          onChange={(e) => onValueChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className="pr-12"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0"
          onClick={() => setShowPassword((visible) => !visible)}
          aria-label={showPassword ? "Hide password" : "Show password"}
          aria-pressed={showPassword}
        >
          {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuthSwitchFooter({
  prompt,
  actionLabel,
  onAction,
}: {
  prompt: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="mt-5 text-center text-sm text-muted-foreground">
      {prompt}{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={onAction}
        className="min-h-11 px-1 text-brand"
      >
        {actionLabel}
      </Button>
    </div>
  );
}

export function AuthSubmitButton({
  canSubmit,
  idleLabel,
  isSubmitting,
  pendingLabel,
}: {
  canSubmit: boolean;
  idleLabel: string;
  isSubmitting: boolean;
  pendingLabel: string;
}) {
  return (
    <Button type="submit" className="w-full" disabled={!canSubmit || isSubmitting}>
      {isSubmitting ? pendingLabel : idleLabel}
    </Button>
  );
}
