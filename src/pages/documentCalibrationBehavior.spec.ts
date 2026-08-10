import { describe, expect, it } from 'vitest';
import { calibrationReviewRpcName, normalizeIncorrectCalibration } from './documentOperationsModel';

const prediction = {
  predicted_action: 'apply_existing_price' as const,
  product_id: '11111111-1111-4111-8111-111111111111',
  proposed_unit_price: 12,
};

describe('calibration review payload behavior', () => {
  it('clears stale product and price when the human action becomes review', () => {
    expect(normalizeIncorrectCalibration(
      prediction, 'review', '22222222-2222-4222-8222-222222222222', '99', ['incorrect_action'],
    )).toEqual({ productId: null, unitPrice: null, problem: null });
  });

  it('records a human price when extraction produced no readable price', () => {
    expect(normalizeIncorrectCalibration(
      { ...prediction, proposed_unit_price: null },
      'create_product', '', '17.50', ['incorrect_price'],
    )).toEqual({ productId: null, unitPrice: 17.5, problem: null });
  });

  it('rejects missing labels, missing prices and unchanged product matches', () => {
    expect(normalizeIncorrectCalibration(prediction, 'review', '', '', []).problem).toContain('סוג טעות');
    expect(normalizeIncorrectCalibration(prediction, 'create_product', '', '', ['incorrect_action']).problem).toContain('מחיר');
    expect(normalizeIncorrectCalibration(
      prediction, 'apply_existing_price', prediction.product_id, '13', ['incorrect_product_match'],
    ).problem).toContain('מוצר אחר');
  });

  it('routes zero-line evidence to the run-level reviewed corpus contract', () => {
    expect(calibrationReviewRpcName(true)).toBe('record_price_list_empty_run_review');
    expect(calibrationReviewRpcName(false)).toBe('record_price_list_calibration_review');
  });
});
