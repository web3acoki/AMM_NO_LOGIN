import { describe, expect, it } from 'vitest';
import { buildBatchTransferRetryPlans } from '../batchTransferRetryPlan';

describe('batch transfer retry planning', () => {
  it('keeps a partial many-to-many retry in many-to-many mode even with one source', () => {
    const plans = buildBatchTransferRetryPlans([{
      source: '0xsource1',
      target: '0xtarget1',
      _tokenType: 'native',
      _transferMode: 'manyToMany',
    }], {
      tokenType: 'native',
      mode: 'oneToMany',
    });

    expect(plans).toEqual([expect.objectContaining({
      tokenType: 'native',
      mode: 'manyToMany',
      sourceAddresses: ['0xsource1'],
      targetAddresses: ['0xtarget1'],
    })]);
  });

  it('keeps many-to-one mode and collapses its repeated target without changing sources', () => {
    const plans = buildBatchTransferRetryPlans([
      {
        source: '0xsource1',
        target: '0xtarget',
        _tokenType: 'token',
        _transferMode: 'manyToOne',
      },
      {
        source: '0xsource2',
        target: '0xTARGET',
        _tokenType: 'token',
        _transferMode: 'manyToOne',
      },
    ], {
      tokenType: 'native',
      mode: 'oneToMany',
    });

    expect(plans).toEqual([expect.objectContaining({
      tokenType: 'token',
      mode: 'manyToOne',
      sourceAddresses: ['0xsource1', '0xsource2'],
      targetAddresses: ['0xtarget'],
    })]);
  });

  it('keeps one-to-many mode and its single-source payment shape', () => {
    const plans = buildBatchTransferRetryPlans([
      {
        source: '0xsource',
        target: '0xtarget1',
        _transferMode: 'oneToMany',
      },
      {
        source: '0xSOURCE',
        target: '0xtarget2',
        _transferMode: 'oneToMany',
      },
    ], {
      tokenType: 'native',
      mode: 'manyToMany',
    });

    expect(plans).toEqual([expect.objectContaining({
      tokenType: 'native',
      mode: 'oneToMany',
      sourceAddresses: ['0xsource'],
      targetAddresses: ['0xtarget1', '0xtarget2'],
    })]);
  });
});
