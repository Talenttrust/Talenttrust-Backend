#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    ArithmeticOverflow = 100,
    InsufficientBalance = 101,
}

pub fn release_payment(env: Env, amount: i128) -> Result<(), Error> {
    let current_balance = get_contract_balance(&env);
    
    // Checked subtraction for safety
    let new_balance = current_balance
        .checked_sub(amount)
        .ok_or(Error::ArithmeticOverflow)?;

    // Checked multiplication for fee calculation
    let fee_bps = 250; // 2.5%
    let fee = amount
        .checked_mul(fee_bps)
        .ok_or(Error::ArithmeticOverflow)?
        .checked_div(10000)
        .ok_or(Error::ArithmeticOverflow)?;

    // Update state...
    Ok(())
}