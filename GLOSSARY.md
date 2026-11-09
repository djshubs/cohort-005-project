# Cadence

Cadence is an online course platform where people buy and take courses. This glossary is the shared language for how the product, its code and its team talk about them.

## Language

### People

**Student**:
A person enrolled in a course, through their own Purchase or a claimed Seat.
_Avoid_: Learner

**Buyer**:
The person who paid for a Purchase, and the only person who can request its Refund. A Student who bought their own place is also its Buyer.
_Avoid_: Purchaser

### Purchases

**Purchase**:
One payment for a course, with its own amount paid. A Buyer can have more than one Purchase for the same course.

**Team Purchase**:
A Purchase of Seats for other people to claim. It does not enrol the Buyer.

**Seat**:
One person's place on a Team Purchase, either claimed or unclaimed.
_Avoid_: Licence

### Refunds

**Refund**:
The return of the full amount paid for one specific Purchase, which also ends the access that Purchase gave. Neither happens unless its Refund Status is Approved.
_Avoid_: Reversal, Cancellation, Partial refund

**Refund Status**:
Where a Refund stands: Requested, Approved or Declined.

**Refund Request**:
A Refund whose status is Requested, still waiting on a decision.

**Declined Refund Request**:
A Refund whose status is Declined, so no money goes back to the Buyer.
_Avoid_: Declined Refund

**Refund Window**:
The period after a Purchase during which a Refund can be requested.

**Refund Eligibility**:
The rules that decide whether a Refund can be requested for a Purchase.
