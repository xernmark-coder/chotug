-- ============================================================================
--  ChotuG ERP — give every product and category its picture
--
--  The client's staff were described as non-technical and asked to recognise a
--  product by sight. The icons themselves live in the web app; this only says
--  which one each product wears, and gives every category a sensible default
--  so a product added tomorrow is never blank.
--
--  Idempotent: only fills what is empty, so a hand-picked icon is never
--  overwritten by a re-run.
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Match on the product's own name first, so "Alphonso" under Mango still gets
-- the mango drawing even though its name says nothing about mangoes.
UPDATE products p SET icon = v.icon
  FROM (VALUES
    ('MANGO','mango'), ('ALPHONSO','mango'), ('KESAR','mango'), ('KOKANI','mango'),
    ('APPLE','apple'), ('BANANA','banana'), ('TOMATO','tomato'),
    ('ONION','onion'), ('POTATO','potato'), ('SPINACH','leafy'),
    ('CAULIFLOWER','cauliflower'), ('CUCUMBER','cucumber'),
    ('CAPSICUM','capsicum'), ('GRAPE','grapes')
  ) AS v(match, icon)
 WHERE p.icon IS NULL
   AND (upper(p.name) LIKE '%'||v.match||'%'
        OR upper(COALESCE(p.variety,'')) LIKE '%'||v.match||'%');

-- Category defaults, so a new product inherits something rather than nothing.
UPDATE product_categories SET icon = CASE segment
        WHEN 'FRUIT'     THEN 'apple'
        WHEN 'VEGETABLE' THEN 'produce'
        WHEN 'GRAIN'     THEN 'sprout'
        WHEN 'SPICE'     THEN 'leafy'
        ELSE 'basket' END
 WHERE icon IS NULL;

-- Anything still unmatched falls back to the generic produce mark rather than
-- rendering an empty square next to its name.
UPDATE products SET icon = 'produce' WHERE icon IS NULL;

COMMIT;
