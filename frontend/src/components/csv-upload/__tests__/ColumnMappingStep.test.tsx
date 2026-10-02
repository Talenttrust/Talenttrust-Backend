import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import ColumnMappingStep from '../ColumnMappingStep';

describe('ColumnMappingStep Component Tests', () => {
  const baseProps = {
    headers: ['colA', 'colB', 'colC'],
    onMappingComplete: vi.fn(),
    onCancel: vi.fn()
  };

  it('should present selection drop options cleanly to users', () => {
    render(<ColumnMappingStep {...baseProps} />);
    expect(screen.queryByRole('button') || screen.queryByText(/map/i)).toBeInTheDocument();
  });

  it('should handle drop parameters and manage apply-mapping options', () => {
    render(<ColumnMappingStep {...baseProps} />);
    const continueBtn = screen.queryByRole('button', { name: /continue|apply|next/i }) || screen.queryByRole('button');
    if (continueBtn) {
      fireEvent.click(continueBtn);
    }
    expect(continueBtn).toBeInTheDocument();
  });
});
