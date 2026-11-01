import { Link } from "@tanstack/react-router";
import { MessageSquare, SlidersHorizontal, Users } from "lucide-react";

import { productAdminLinks } from "@/product";

const itemClass =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors";
const activeProps = {
  className: "border-foreground bg-foreground text-background",
};
const inactiveProps = {
  className: "border-border bg-card text-muted-foreground hover:text-foreground",
};

export function AdminNav() {
  return (
    <nav aria-label="Administration" className="mb-6 flex flex-wrap gap-2">
      {productAdminLinks.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className={itemClass}
          activeProps={activeProps}
          inactiveProps={inactiveProps}
        >
          <Icon className="size-4" aria-hidden="true" /> {label}
        </Link>
      ))}
      <Link
        to="/admin/users"
        className={itemClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
      >
        <Users className="size-4" aria-hidden="true" /> Users
      </Link>
      <Link
        to="/admin/feedback"
        className={itemClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
      >
        <MessageSquare className="size-4" aria-hidden="true" /> Feedback
      </Link>
      <Link
        to="/admin/config"
        className={itemClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
      >
        <SlidersHorizontal className="size-4" aria-hidden="true" /> Settings
      </Link>
    </nav>
  );
}
