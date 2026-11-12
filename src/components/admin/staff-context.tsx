"use client";

/**
 * The signed-in staff member, resolved on the server by `src/app/admin/layout.tsx` and handed to
 * client pages so they can hide actions the role cannot take (the API enforces them anyway).
 */

import { createContext, useContext, type ReactNode } from "react";
import { can, gateFor, type Permission, type StaffRoleName } from "@/lib/admin/permissions";

interface StaffInfo {
  userId: string;
  email: string | null;
  role: StaffRoleName;
  pinned: boolean;
}

const StaffContext = createContext<StaffInfo | null>(null);

export function StaffProvider({ value, children }: { value: StaffInfo; children: ReactNode }) {
  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaff() {
  const staff = useContext(StaffContext);
  if (!staff) throw new Error("useStaff() must be used inside the staff console layout");
  return {
    ...staff,
    can: (permission: Permission) => can(staff.role, permission),
    gate: (permission: Permission) => gateFor(staff.role, permission),
  };
}
