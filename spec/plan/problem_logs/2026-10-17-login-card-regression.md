# Login entry design and undefined legacy screen regression

- User reports: original rounded card was removed; clicking passkey login displays an undefined legacy screen.
- Cause: new LoginEntry omitted original card styling, and CompositeLoginPage swapped it for CompositeLogin after activation.
- Fix: preserve LoginEntry for the complete ceremony, mount a status-only LoginAttempt after explicit activation, and restore the original card surface/border/radius/padding. Keep the defined cookie choices and enrollment preference.
- Regression coverage: original card markup and no legacy controls in authentication/cancellation status.
