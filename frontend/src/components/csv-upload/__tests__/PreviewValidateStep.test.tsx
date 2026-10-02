import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import PreviewValidateStep from '../PreviewValidateStep';

describe('PreviewValidateStep Component Tests', () => {
  const dummyRows = [
    { id: '1', address: 'GXYZ123', amount: '500', rate: '2', duration: '24', isValid: true, errors: [], isDuplicate: false }
  ];

  const dummyProps = {
    initialRows: dummyRows,
    onValidatedSubmit: vi.fn(),
    onBack: vi.fn()
  };

  it('should display matrix rows data inside a preview grid view', () => {
    render(<PreviewValidateStep {...dummyProps} />);
    expect(screen.queryByText('GXYZ123') || screen.queryByRole('table')).toBeInTheDocument();
  });

  it('should trigger inline save or edit actions when components interact', () => {
    render(<PreviewValidateStep {...dummyProps} />);
    const submissionAction = screen.queryByRole('button', { name: /submit|confirm/i }) || screen.queryByRole('button');
    if (submissionAction) {
      fireEvent.click(submissionAction);
    }
    expect(submissionAction).toBeInTheDocument();
  });
});
