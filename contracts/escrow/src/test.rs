#[test]
#[should_panic(expected = "ArithmeticOverflow")]
fn test_overflow_on_deposit() {
    let env = Env::default();
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    // Use maximum value of i128 to trigger overflow on addition
    let max_val = i128::MAX;
    client.deposit(&max_val, &1); // Should fail when adding even 1
}

#[test]
fn test_underflow_protection() {
    let env = Env::default();
    // ... setup ...
    // Attempting to release more than the balance should trigger ArithmeticOverflow
    let result = client.try_release_payment(&1000); 
    assert_eq!(result, Err(Ok(Error::ArithmeticOverflow)));
}