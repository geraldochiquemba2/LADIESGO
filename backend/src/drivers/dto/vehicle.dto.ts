import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// PUT /drivers/vehicle — a própria motorista atualiza os dados da viatura.
// Tudo opcional (atualiza só o enviado); matrícula verifica duplicados.
export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  carMake?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  carModel?: string;

  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(new Date().getFullYear() + 1)
  carYear?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  carColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  carPlate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  licenseNumber?: string;
}
