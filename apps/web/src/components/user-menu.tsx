import { Button } from "@northwind/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@northwind/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  CircleUserRound,
  CreditCard,
  LogOut,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
} from "lucide-react";

import type { AppUser } from "@/components/app-shell";
import {
  useTheme,
  useThemeTransition,
} from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { resetAnalyticsIdentity } from "@/lib/analytics";
import { productAccountLinks, productAdminHome } from "@/product";

export default function UserMenu({
  user,
  isAdmin,
}: {
  user: AppUser;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme } = useTheme();
  const switchTheme = useThemeTransition();
  const themes = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="Open account menu" />}
      >
        <CircleUserRound className="size-5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-xl bg-popover p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 py-2">
            <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
            <span className="mt-0.5 block truncate text-xs font-normal">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {productAccountLinks.map(({ to, label, icon: Icon }) => (
            <DropdownMenuItem
              key={to}
              className="min-h-11 rounded-lg px-2.5 text-sm"
              onClick={() => navigate({ to })}
            >
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            className="min-h-11 rounded-lg px-2.5 text-sm"
            onClick={() => navigate({ to: "/account/billing" })}
          >
            <CreditCard aria-hidden="true" />
            Plan &amp; billing
          </DropdownMenuItem>
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="min-h-11 rounded-lg px-2.5 text-sm"
                onClick={() => navigate({ to: productAdminHome })}
              >
                <ShieldCheck aria-hidden="true" />
                Administration
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuLabel className="px-2.5 pb-1 pt-2">Appearance</DropdownMenuLabel>
          {themes.map(({ value, label, icon: Icon }) => (
            <DropdownMenuItem
              key={value}
              className="min-h-11 rounded-lg px-2.5 text-sm"
              onClick={() => switchTheme(value)}
            >
              <Icon aria-hidden="true" />
              {label}
              {theme === value ? <Check className="ml-auto" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="min-h-11 rounded-lg px-2.5 text-sm"
            onClick={() => navigate({ to: "/account/delete" })}
          >
            <Trash2 aria-hidden="true" />
            Delete account
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className="min-h-11 rounded-lg px-2.5 text-sm"
            onClick={() => {
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    resetAnalyticsIdentity();
                    queryClient.clear();
                    navigate({
                      to: "/login",
                    });
                  },
                },
              });
            }}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
