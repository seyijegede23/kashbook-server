// Anchor BusinessCustomer.industry enum — the full supported list, verbatim
// from https://docs.getanchor.co/docs/business-customer-creation.md
// ("Registration Types and Industry" accordion), verified against the
// sandbox /customers validator on 2026-06-12.
//
// Anchor deserializes an unknown industry string to null and rejects the
// create with "industry must not be null", which burns a KYB attempt.
// Phase A in routes/businesses.js validates against this set first.
//
// Note: the sandbox also accepts the hyphen variant of compound values
// ("Commerce-DigitalServices"), but we standardise on underscores — the
// format used in Anchor's own enum listing.
const ANCHOR_INDUSTRIES = new Set([
  "Agriculture_AgriculturalCooperatives",
  "Agriculture_AgriculturalServices",
  "Commerce_Automobiles",
  "Commerce_DigitalGoods",
  "Commerce_PhysicalGoods",
  "Commerce_RealEstate",
  "Commerce_DigitalServices",
  "Commerce_LegalServices",
  "Commerce_PhysicalServices",
  "Commerce_ProfessionalServices",
  "Commerce_OtherProfessionalServices",
  "Education_NurserySchools",
  "Education_PrimarySchools",
  "Education_SecondarySchools",
  "Education_TertiaryInstitutions",
  "Education_VocationalTraining",
  "Education_VirtualLearning",
  "Education_OtherEducationalServices",
  "Gaming_Betting",
  "Gaming_Lotteries",
  "Gaming_PredictionServices",
  "FinancialServices_FinancialCooperatives",
  "FinancialServices_CorporateServices",
  "FinancialServices_PaymentSolutionServiceProviders",
  "FinancialServices_Insurance",
  "FinancialServices_Investments",
  "FinancialServices_AgriculturalInvestments",
  "FinancialServices_Lending",
  "FinancialServices_BillPayments",
  "FinancialServices_Payroll",
  "FinancialServices_Remittances",
  "FinancialServices_Savings",
  "FinancialServices_MobileWallets",
  "Health_Gyms",
  "Health_Hospitals",
  "Health_Pharmacies",
  "Health_HerbalMedicine",
  "Health_Telemedicine",
  "Health_MedicalLaboratories",
  "Hospitality_Hotels",
  "Hospitality_Restaurants",
  "Nonprofits_ProfessionalAssociations",
  "Nonprofits_GovernmentAgencies",
  "Nonprofits_NGOs",
  "Nonprofits_PoliticalParties",
  "Nonprofits_ReligiousOrganizations",
  "Nonprofits_Leisure_Entertainment",
  "Nonprofits_Cinemas",
  "Nonprofits_Nightclubs",
  "Nonprofits_Events",
  "Nonprofits_Press_Media",
  "Nonprofits_RecreationCentres",
  "Nonprofits_StreamingServices",
  "Logistics_CourierServices",
  "Logistics_FreightServices",
  "Travel_Airlines",
  "Travel_Ridesharing",
  "Travel_TourServices",
  "Travel_Transportation",
  "Travel_TravelAgencies",
  "Utilities_CableTelevision",
  "Utilities_Electricity",
  "Utilities_Garbage_Disposal",
  "Utilities_Internet",
  "Utilities_Telecoms",
  "Utilities_Water",
  "Retail",
  "Wholesale",
  "Restaurants",
  "Construction",
  "Unions",
  "RealEstate",
  "FreelanceProfessional",
  "OtherProfessionalServices",
  "OtherEducationServices",
]);

function isValidAnchorIndustry(value) {
  return typeof value === "string" && ANCHOR_INDUSTRIES.has(value);
}

module.exports = { ANCHOR_INDUSTRIES, isValidAnchorIndustry };
