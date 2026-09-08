import type { PermissionDecision, WriteActionKind } from "./policy";

export interface AuditEntry {
	action: WriteActionKind;
	ref: string;
	snapshotId: string;
	decision: PermissionDecision;
	result: string;
	valueLength?: number;
	redacted?: boolean;
}

export class ActionAudit {
	readonly limit: number;
	private buffer: AuditEntry[] = [];

	constructor(limit = 200) {
		this.limit = Math.max(1, limit);
	}

	record(entry: AuditEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > this.limit) {
			this.buffer.splice(0, this.buffer.length - this.limit);
		}
	}

	get entries(): readonly AuditEntry[] {
		return [...this.buffer];
	}
}
