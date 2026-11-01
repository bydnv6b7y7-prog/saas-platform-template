import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import * as React from "react";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}

export { useTheme } from "next-themes";

export type ThemeChoice = "light" | "dark" | "system";

/**
 * 三处主题入口（图标切换 / 账号菜单 / 页脚 select）共用的切换逻辑：
 * 加 300ms 颜色过渡类，避免亮/暗跳变。
 */
export function useThemeTransition() {
  const { setTheme } = useTheme();
  return React.useCallback(
    (theme: ThemeChoice) => {
      const el = document.documentElement;
      el.classList.add("theme-transition");
      window.setTimeout(() => el.classList.remove("theme-transition"), 350);
      setTheme(theme);
    },
    [setTheme],
  );
}
