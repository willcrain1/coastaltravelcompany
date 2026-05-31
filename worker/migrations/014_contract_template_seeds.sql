-- Default contract templates for each Coastal Travel Company collection.
-- Uses INSERT OR IGNORE with deterministic IDs so re-running is safe.

INSERT OR IGNORE INTO contract_templates (id, name, collection_type, body, created_at, updated_at) VALUES
(
  'default-editorial-stay-v1',
  'The Editorial Stay',
  'editorial_stay',
  '<h2>Scope of Work</h2>
<p>Coastal Travel Company ("Photographer") agrees to provide professional property photography services for <strong>{{property_name}}</strong> located at {{location}}. The shoot is scheduled for <strong>{{shoot_date}}</strong> and covers interior and exterior spaces as agreed in the pre-shoot brief. The collection engaged is <strong>The Editorial Stay</strong>.</p>

<h2>Deliverables &amp; Timeline</h2>
<ul>
<li>Minimum 80 fully edited, high-resolution digital images</li>
<li>Files delivered in web-optimized (72 dpi) and print-ready (300 dpi) formats</li>
<li>Final gallery delivered within 14 business days of the shoot date</li>
<li>One round of minor revision requests accepted within 7 days of gallery delivery</li>
</ul>

<h2>Fees &amp; Payment Schedule</h2>
<p>Total photography fee: <strong>{{total_fee}}</strong>.</p>
<ul>
<li>50% retainer due upon contract execution to secure the booking date</li>
<li>Remaining 50% due no later than 7 days prior to the shoot date</li>
<li>Payment accepted via the secure invoice link provided by Coastal Travel Company</li>
<li>Unpaid balances at the time of the shoot may result in cancellation; the retainer is forfeited in such cases</li>
</ul>

<h2>Cancellation &amp; Rescheduling Policy</h2>
<ul>
<li>Cancellation 30+ days before the shoot: retainer refunded less a $150 administrative fee</li>
<li>Cancellation 14–30 days before the shoot: 50% of the total fee is forfeited</li>
<li>Cancellation fewer than 14 days before the shoot: 100% of the total fee is forfeited</li>
<li>Rescheduling 14+ days in advance: accommodated at no charge, subject to Photographer''s availability</li>
<li>Rescheduling fewer than 14 days in advance: a $200 rescheduling fee applies</li>
</ul>

<h2>Licensing &amp; Usage Rights</h2>
<p><strong>{{client_name}}</strong> ("Client") is granted, upon receipt of full payment, a non-exclusive, perpetual, worldwide license to use the delivered images for digital marketing, social media, website content, print collateral, and editorial publication directly associated with {{property_name}}. Images may not be sublicensed, resold, or transferred to third parties without prior written consent. Coastal Travel Company retains the right to use any delivered images in its portfolio and promotional materials unless a separate exclusivity agreement is executed in writing prior to the shoot.</p>

<h2>Limitation of Liability</h2>
<p>Coastal Travel Company''s total liability under this agreement is limited to the fees paid. Coastal Travel Company shall not be liable for indirect, incidental, or consequential damages. In the event of equipment failure, illness, or circumstances beyond the Photographer''s reasonable control, every reasonable effort will be made to reschedule the shoot at no additional cost. If rescheduling is not possible, liability is limited to a full refund of all fees paid under this agreement.</p>

<h2>Governing Law</h2>
<p>This agreement is governed by the laws of the State of Florida. Any disputes shall be resolved by binding arbitration in Florida, or in a court of competent jurisdiction in the State of Florida.</p>',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
),
(
  'default-fashioned-weekend-v1',
  'The Fashioned Weekend',
  'fashioned_weekend',
  '<h2>Scope of Work</h2>
<p>Coastal Travel Company ("Photographer") agrees to provide professional fashion and lifestyle photography services for <strong>{{client_name}}</strong> ("Client") at <strong>{{property_name}}</strong>, {{location}}. The shoot is scheduled for <strong>{{shoot_date}}</strong>. The collection engaged is <strong>The Fashioned Weekend</strong>. Services include on-location creative direction of talent and styling, with the property serving as the primary creative backdrop.</p>

<h2>Deliverables &amp; Timeline</h2>
<ul>
<li>Minimum 100 fully edited, high-resolution digital images</li>
<li>Creative direction and on-set styling guidance included</li>
<li>Files delivered in web-optimized and print-ready formats</li>
<li>Final gallery delivered within 14 business days of the shoot date</li>
<li>One round of minor revision requests accepted within 7 days of gallery delivery</li>
</ul>

<h2>Fees &amp; Payment Schedule</h2>
<p>Total photography fee: <strong>{{total_fee}}</strong>.</p>
<ul>
<li>50% retainer due upon contract execution to secure the booking date</li>
<li>Remaining 50% due no later than 7 days prior to the shoot date</li>
<li>Talent, wardrobe, and styling expenses not directly provided by Coastal Travel Company are the Client''s sole responsibility</li>
<li>Payment accepted via the secure invoice link provided by Coastal Travel Company</li>
</ul>

<h2>Cancellation &amp; Rescheduling Policy</h2>
<ul>
<li>Cancellation 30+ days before the shoot: retainer refunded less a $150 administrative fee</li>
<li>Cancellation 14–30 days before the shoot: 50% of the total fee is forfeited</li>
<li>Cancellation fewer than 14 days before the shoot: 100% of the total fee is forfeited</li>
<li>Rescheduling 14+ days in advance: accommodated at no charge, subject to Photographer''s availability</li>
<li>Rescheduling fewer than 14 days in advance: a $250 rescheduling fee applies</li>
<li>Weather-related delays: every reasonable effort will be made to reschedule at no additional cost</li>
</ul>

<h2>Licensing &amp; Usage Rights</h2>
<p>Upon receipt of full payment, Client is granted a non-exclusive, perpetual, worldwide license to use delivered images for editorial publication, social media, personal and professional portfolio, and brand promotion. If the property owner is a separate party from Client, the property owner is granted the same license for the property''s marketing use. Coastal Travel Company retains the right to feature any delivered images in its portfolio and promotional materials. Images may not be sublicensed to third-party commercial campaigns without a separate written licensing agreement.</p>

<h2>Limitation of Liability</h2>
<p>Coastal Travel Company''s total liability under this agreement is limited to the fees paid. Coastal Travel Company is not responsible for talent cancellations, wardrobe or property access issues, or losses resulting from circumstances outside the Photographer''s direct control. In the event of equipment failure or circumstances beyond the Photographer''s reasonable control, every effort will be made to reschedule at no additional cost. If rescheduling is not possible, liability is limited to a full refund of all fees paid.</p>

<h2>Governing Law</h2>
<p>This agreement is governed by the laws of the State of Florida. Any disputes shall be resolved by binding arbitration in Florida, or in a court of competent jurisdiction in the State of Florida.</p>',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
),
(
  'default-branded-journey-v1',
  'The Branded Journey',
  'branded_journey',
  '<h2>Scope of Work</h2>
<p>Coastal Travel Company ("Photographer") agrees to provide professional commercial brand photography services for <strong>{{client_name}}</strong> ("Client") at <strong>{{property_name}}</strong>, {{location}}. The campaign shoot is scheduled for <strong>{{shoot_date}}</strong>. The collection engaged is <strong>The Branded Journey</strong>. Services include creative direction, multi-location coverage within the property, brand storytelling, and production of campaign-ready imagery for broad commercial use.</p>

<h2>Deliverables &amp; Timeline</h2>
<ul>
<li>Minimum 120 fully edited, high-resolution digital images</li>
<li>Creative direction and brand-aligned storytelling throughout the shoot</li>
<li>Files delivered in web-optimized and print-ready formats; select hero images delivered at maximum resolution</li>
<li>Final gallery delivered within 10 business days of the shoot date</li>
<li>Two rounds of revision requests included within 14 days of gallery delivery</li>
</ul>

<h2>Fees &amp; Payment Schedule</h2>
<p>Total photography fee: <strong>{{total_fee}}</strong>.</p>
<ul>
<li>50% retainer due upon contract execution to secure the booking date</li>
<li>Remaining 50% due no later than 7 days prior to the first shoot day</li>
<li>Pre-approved production expenses (props, permits, location fees) invoiced separately at cost plus 15%</li>
<li>Payment accepted via the secure invoice link provided by Coastal Travel Company</li>
</ul>

<h2>Cancellation &amp; Rescheduling Policy</h2>
<ul>
<li>Cancellation 45+ days before the shoot: retainer refunded less a $200 administrative fee</li>
<li>Cancellation 15–44 days before the shoot: 50% of the total fee is forfeited</li>
<li>Cancellation fewer than 15 days before the shoot: 100% of the total fee is forfeited</li>
<li>Rescheduling 15+ days in advance: accommodated at no charge, subject to Photographer''s availability</li>
<li>Rescheduling fewer than 15 days in advance: a $350 rescheduling fee applies</li>
</ul>

<h2>Licensing &amp; Usage Rights</h2>
<p>Upon receipt of full payment, Client is granted a non-exclusive, perpetual, worldwide license to use delivered images for all commercial purposes, including advertising, digital and print campaigns, brand collateral, website use, social media, press releases, and licensing to the Client''s affiliated brands and partners directly involved in the campaign. Images may not be resold as stock photography or transferred to unaffiliated third parties without prior written consent. Coastal Travel Company retains the right to use any delivered images in its portfolio and promotional materials unless a separate exclusivity agreement is executed. Where exclusivity is required, an exclusivity fee will be negotiated separately in writing.</p>

<h2>Limitation of Liability</h2>
<p>Coastal Travel Company''s total liability under this agreement is limited to the fees paid. Coastal Travel Company shall not be liable for indirect, incidental, consequential, or special damages arising from any cause. In the event of equipment failure, illness, or circumstances beyond the Photographer''s reasonable control preventing completion of the shoot, every reasonable effort will be made to reschedule at no additional cost. If rescheduling is not feasible, liability is limited to a full refund of all amounts paid under this agreement.</p>

<h2>Governing Law</h2>
<p>This agreement is governed by the laws of the State of Florida. All disputes arising under or relating to this agreement shall be submitted to binding arbitration in the State of Florida, or in a court of competent jurisdiction in Florida.</p>',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);
