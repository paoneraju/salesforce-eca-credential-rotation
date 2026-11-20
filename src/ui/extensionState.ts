import type { AuditEntry } from "../core/audit/auditService";
import type { Eca, SalesforceOrg } from "../core/types";
import { sameOrg } from "./config";

export class ExtensionState {
  orgs: SalesforceOrg[] = [];
  orgsError?: string;
  orgsLoading = false;

  selectedOrg?: SalesforceOrg;
  selectedOrgAvailable = false;

  ecas: Eca[] = [];
  ecasError?: string;
  ecasLoading = false;
  selectedEca?: Eca;

  auditEntries: AuditEntry[] = [];
  auditError?: string;
  auditLoading = false;

  setSelectedOrg(org: SalesforceOrg | undefined, available: boolean): void {
    this.selectedOrg = org;
    this.selectedOrgAvailable = available;
    if (!org) {
      this.ecas = [];
      this.selectedEca = undefined;
      this.ecasError = undefined;
    }
  }

  isSelectedOrg(org: SalesforceOrg): boolean {
    return sameOrg(this.selectedOrg, org);
  }

  findEca(eca: Eca): Eca | undefined {
    return this.ecas.find(
      (entry) => entry.identifier === eca.identifier && entry.consumer?.id === eca.consumer?.id
    );
  }

  setEcas(ecas: Eca[]): void {
    this.ecas = ecas;
    this.ecasError = undefined;
    if (this.selectedEca) {
      this.selectedEca = this.findEca(this.selectedEca);
    }
  }

  clearEcas(): void {
    this.ecas = [];
    this.ecasError = undefined;
    this.selectedEca = undefined;
  }
}

export function hasSupportedEca(eca: Eca | undefined): boolean {
  return Boolean(eca && eca.supported && eca.consumer);
}
