import { describe, expect, it } from 'vitest';

import { Command, CommandResult } from './pb/vfm/agent/v1/command';
import { ErrorCode } from './pb/vfm/agent/v1/common';
import { AgentMessage, ServerMessage } from './pb/vfm/agent/v1/gateway';
import { InventorySnapshot, ResourceKind } from './pb/vfm/agent/v1/inventory';

/**
 * The generated TypeScript stubs are the gateway's half of the agent contract
 * (proto/vfm/agent/v1). These pin the properties the rest of M2 relies on, so a
 * regeneration that changes them fails here rather than on a live stream.
 */
describe('agent protocol contract (TS stubs)', () => {
  it('round-trips a Hello with the agent policy', () => {
    const message = AgentMessage.fromPartial({
      messageId: '0194f9d2-0000-7000-8000-000000000001',
      hello: {
        protocolVersion: 1,
        agentVersion: '0.1.0',
        clusterFingerprint: 'abc',
        velero: {
          serverVersion: 'v1.18.4',
          plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
        },
        policy: { allowRestore: true, restoreDeniedNamespaces: ['kube-system'], readOnly: false },
      },
    });
    const decoded = AgentMessage.decode(AgentMessage.encode(message).finish());
    expect(decoded.hello?.velero?.plugins[0]?.name).toBe('velero.io/aws');
    expect(decoded.hello?.policy?.restoreDeniedNamespaces).toEqual(['kube-system']);
  });

  it('keeps "unset" distinct from false for optional Velero booleans', () => {
    const unset = Command.fromPartial({
      commandId: 'c1',
      createBackup: { name: 'b', spec: {} },
    });
    const off = Command.fromPartial({
      commandId: 'c2',
      createBackup: { name: 'b', spec: { snapshotVolumes: false } },
    });
    const decode = (c: Command): boolean | undefined =>
      Command.decode(Command.encode(c).finish()).createBackup?.spec?.snapshotVolumes;
    expect(decode(unset)).toBeUndefined();
    expect(decode(off)).toBe(false);
  });

  it('carries exactly one command op and one payload', () => {
    const server = ServerMessage.decode(
      ServerMessage.encode(
        ServerMessage.fromPartial({
          messageId: 'm',
          command: { commandId: 'c', refreshStatus: {} },
        }),
      ).finish(),
    );
    expect(server.command?.refreshStatus).toBeDefined();
    expect(server.command?.createBackup).toBeUndefined();
    expect(server.cancel).toBeUndefined();
  });

  it('has no resource kind that could carry a Secret', () => {
    expect(Object.keys(ResourceKind).some((k) => /SECRET/i.test(k))).toBe(false);
    const snapshot = InventorySnapshot.fromPartial({
      snapshotId: 's',
      sequence: 0,
      last: true,
      items: [
        {
          kind: ResourceKind.RESOURCE_KIND_BACKUP,
          name: 'b',
          objectJson: new Uint8Array([123, 125]),
        },
      ],
    });
    expect(
      InventorySnapshot.decode(InventorySnapshot.encode(snapshot).finish()).items[0]?.name,
    ).toBe('b');
  });

  it('reports a failed command with a typed error code and no detail', () => {
    const result = CommandResult.fromPartial({
      commandId: 'c',
      ok: false,
      errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
      errorMessage: 'policy',
    });
    const decoded = CommandResult.decode(CommandResult.encode(result).finish());
    expect(decoded.ok).toBe(false);
    expect(decoded.errorCode).toBe(ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY);
    expect(decoded.serverStatus).toBeUndefined();
  });
});
